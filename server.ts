import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { spawn, execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import OpenAI from 'openai';

const app = express();
const PORT = process.env.PORT || 3001;

// Check if Playwright is properly installed
async function checkPlaywrightInstallation(): Promise<void> {
  try {
    // Try to get Playwright executable path
    const result = execSync('npx playwright --version', { encoding: 'utf8' });
    console.log('✅ Playwright gefunden:', result.trim());
    
    // Check if chromium is installed
    try {
      const chromiumCheck = execSync('npx playwright install --dry-run chromium 2>&1', { encoding: 'utf8' });
      if (chromiumCheck.includes('is already installed')) {
        console.log('✅ Chromium Browser ist installiert');
      } else {
        console.warn('⚠️  Chromium Browser fehlt. Installiere...');
        execSync('npx playwright install chromium', { stdio: 'inherit' });
        console.log('✅ Chromium Browser erfolgreich installiert');
      }
    } catch (error) {
      console.warn('⚠️  Chromium Browser wird installiert...');
      execSync('npx playwright install chromium', { stdio: 'inherit' });
      console.log('✅ Chromium Browser erfolgreich installiert');
    }
  } catch (error) {
    console.error('❌ Playwright ist nicht korrekt installiert.');
    console.error('Bitte führe aus: npm install && npx playwright install chromium');
    process.exit(1);
  }
}

// Middleware
app.use(cors());
app.use(express.json());

// Root route for debugging
app.get('/', (req, res) => {
  res.json({ message: 'Amazon to YNAB Sync API Server is running' });
});

// Check YNAB configuration status
app.get('/api/ynab-config', (req, res) => {
  const config = checkYnabConfig();
  res.json(config);
});

// Types
interface Transaction {
  date: string | null;
  amount: string | null;
  paymentInstrument: string | null;
  merchant: string | null;
  orderId: string | null;
  orderUrl: string | null;
  isRefund: boolean;
  orderDescription: string | null;
  orderTitles?: string[] | null;
  orderItems?: { title: string; price?: string | null }[] | null;
  aiSummary?: string | null;
  ynabSynced?: boolean;
  ynabSync?: {
    at?: string;
    importId?: string;
    ynabTransactionId?: string | null;
    duplicateImportId?: boolean;
    amountMilliunits?: number | null;
  } | null;
}

type ScriptResult = {
  stdout: string;
  stderr: string;
};

type ScriptError = Error & ScriptResult;

type SyncStatus = {
  status: 'idle' | 'running' | 'success' | 'error';
  startedAt?: number;
  finishedAt?: number;
  logs: { line: string; stream: 'stdout' | 'stderr'; timestamp: number }[];
  error?: string | null;
};

type SyncRequestOptions = {
  mode?: 'current-month' | 'last-n' | 'date-range';
  lastCount?: number;
  startDate?: string;
  endDate?: string;
};

const syncState: SyncStatus = {
  status: 'idle',
  logs: []
};

const openaiApiKey = process.env.OPENAI_API_KEY;

// Check YNAB configuration
function checkYnabConfig(): { configured: boolean; missing: string[] } {
  const missing: string[] = [];
  
  if (!process.env.YNAB_TOKEN) missing.push('YNAB_TOKEN');
  if (!process.env.YNAB_ACCOUNT_ID) missing.push('YNAB_ACCOUNT_ID');
  
  return {
    configured: missing.length === 0,
    missing
  };
}
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

const SUMMARY_MAX_LENGTH = 120;
const FALLBACK_MODEL = process.env.OPENAI_FALLBACK_MODEL || 'gpt-4o-mini';
const SUMMARY_SYSTEM_PROMPT = 'Kürze folgende Amazon-Bestellbeschreibung für ein YNAB-Memo. Nutze höchstens 100 Zeichen, bleibe auf Deutsch, entferne Dopplungen und achte darauf, dass alle Artikel enthalten sind. Fasse dich so kurz wie möglich. Beschreibe nur den eigentlichen Artikel ohne seine eigenschaften. Beispiel: "Buch: Der Alchimist, USB-C Kabel, Bluetooth Kopfhörer". Statt "Trinkflasche MYFOREST 1 L, auslaufsicher, spülmaschinenfest, BPA-frei, inkl. Deckel, Halterung, Karabiner, transparent…" soll bspw. nur "Trinkflasche" als Artikelname verwendet werden.';

function truncateSummary(text: string): string {
  if (text.length <= SUMMARY_MAX_LENGTH) return text;
  return text.slice(0, SUMMARY_MAX_LENGTH - 1).trimEnd() + '…';
}

function flattenOutput(node: any): string {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(flattenOutput).join(' ');
  if (typeof node === 'object') {
    if (typeof node.text === 'string') return node.text;
    if (node.text && typeof node.text.value === 'string') return node.text.value;
    if (typeof node.output_text === 'string') return node.output_text;
    if (node.output_text && typeof node.output_text.value === 'string') return node.output_text.value;
    if (typeof node.value === 'string') return node.value;
    if (node.content) return flattenOutput(node.content);
  }
  return '';
}

async function summarizeWithGpt5Nano(text: string): Promise<string | null> {
  if (!openai) return null;
  try {
    const response = await openai.responses.create({
      model: 'gpt-5-nano-2025-08-07',
      input: [
        {
          role: 'developer',
          content: [
            {
              type: 'input_text',
              text: SUMMARY_SYSTEM_PROMPT
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'input_text',
              text
            }
          ]
        }
      ],
      reasoning: { effort: 'minimal' as any },
      max_output_tokens: 800
    });

    console.log('[AI] gpt-5-nano metadata', {
      status: (response as any)?.status,
      usage: (response as any)?.usage,
      incomplete: (response as any)?.incomplete_details
    });

    const collected = flattenOutput((response as any)?.output) || flattenOutput((response as any)?.output_text);
    const summary = collected.trim();
    if (!summary || (response as any)?.status !== 'completed') {
      console.warn('[AI] gpt-5-nano lieferte keine verwertbare Zusammenfassung.');
      return null;
    }
    return summary;
  } catch (error) {
    console.error('[AI] gpt-5-nano Anfrage fehlgeschlagen', error);
    return null;
  }
}

async function summarizeWithFallbackModel(text: string): Promise<string | null> {
  if (!openai) return null;
  try {
    const completion = await openai.chat.completions.create({
      model: FALLBACK_MODEL,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
        { role: 'user', content: text }
      ],
      max_completion_tokens: 120,
      temperature: 1
    });

    const summary = completion.choices?.[0]?.message?.content?.trim();
    console.log('[AI] Fallback completion metadata', {
      model: FALLBACK_MODEL,
      usage: completion.usage,
      finish_reason: completion.choices?.[0]?.finish_reason
    });
    return summary && summary.length > 0 ? summary : null;
  } catch (error) {
    console.error('[AI] Fallback Modell fehlgeschlagen', error);
    return null;
  }
}

function normalizeSyncOptions(raw: any): SyncRequestOptions | undefined {
  if (!raw || typeof raw !== 'object') return undefined;

  const options: SyncRequestOptions = {};
  if (raw.mode && typeof raw.mode === 'string') {
    if (raw.mode === 'current-month' || raw.mode === 'last-n' || raw.mode === 'date-range') {
      options.mode = raw.mode;
    }
  }

  if (options.mode === 'last-n') {
    const last = Number(raw.lastCount ?? raw.last ?? raw.count);
    if (!Number.isFinite(last) || last <= 0) {
      throw new Error('lastCount muss eine Zahl größer 0 sein.');
    }
    options.lastCount = Math.floor(last);
  }

  if (options.mode === 'date-range') {
    const start = typeof raw.startDate === 'string' ? raw.startDate.trim() : '';
    const end = typeof raw.endDate === 'string' ? raw.endDate.trim() : '';
    if (!start || !end) {
      throw new Error('startDate und endDate sind erforderlich.');
    }
    const startTime = Date.parse(start);
    const endTime = Date.parse(end);
    if (Number.isNaN(startTime) || Number.isNaN(endTime)) {
      throw new Error('Ungültiger Datumsbereich.');
    }
    if (startTime > endTime) {
      throw new Error('startDate darf nicht nach endDate liegen.');
    }
    options.startDate = start;
    options.endDate = end;
  }

  return Object.keys(options).length > 0 ? options : undefined;
}

// Helper function to run scripts
function runScript(scriptPath: string, args: string[] = []): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('npx', ['ts-node', scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: process.env  // Pass environment variables to child process
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => {
        stdoutChunks.push(data.toString());
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => {
        stderrChunks.push(data.toString());
      });
    }

    child.on('error', (error) => {
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      const scriptError = new Error(error.message) as ScriptError;
      scriptError.stdout = stdout;
      scriptError.stderr = stderr;
      reject(scriptError);
    });

    child.on('close', (code) => {
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const scriptError = new Error(`Script exited with code ${code}`) as ScriptError;
        scriptError.stdout = stdout;
        scriptError.stderr = stderr;
        reject(scriptError);
      }
    });
  });
}

function extractYnabSummary(stdout: string) {
  const lines = stdout.split(/\r?\n/);
  const cleaned: string[] = [];
  let summary: unknown = null;

  for (const line of lines) {
    if (line.startsWith('[YNAB][SUMMARY] ')) {
      if (summary === null) {
        const payload = line.slice('[YNAB][SUMMARY] '.length).trim();
        try {
          summary = JSON.parse(payload);
        } catch {
          summary = null;
        }
      }
      continue;
    }
    cleaned.push(line);
  }

  const cleanedStdout = cleaned.join('\n').trim();
  return { summary, cleanedStdout };
}

function buildSyncArgs(options?: SyncRequestOptions): string[] {
  const args = ['ts-node', 'transactions-to-json.ts'];
  if (!options) return args;

  if (options.mode) {
    args.push('--mode', options.mode);
  }
  if (options.mode === 'last-n' && typeof options.lastCount === 'number') {
    args.push('--last', String(options.lastCount));
  }
  if (options.mode === 'date-range') {
    if (options.startDate) args.push('--start', options.startDate);
    if (options.endDate) args.push('--end', options.endDate);
  }
  return args;
}

function startSyncScript(options?: SyncRequestOptions): Promise<ScriptResult> {
  if (syncState.status === 'running') {
    return Promise.reject(new Error('Sync läuft bereits.'));
  }

  syncState.status = 'running';
  syncState.startedAt = Date.now();
  syncState.finishedAt = undefined;
  syncState.logs = [];
  syncState.error = null;

  const args = buildSyncArgs(options);

  syncState.logs.push({
    line: `[SYNC] Starte Sync mit Argumenten: ${args.slice(1).join(' ') || 'standard'}`,
    stream: 'stdout',
    timestamp: Date.now()
  });
  if (syncState.logs.length > 200) {
    syncState.logs.splice(0, syncState.logs.length - 200);
  }

  return new Promise((resolve, reject) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const child = spawn('npx', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });

    const capture = (stream: 'stdout' | 'stderr', data: Buffer) => {
      const text = data.toString();
      if (stream === 'stdout') stdoutChunks.push(text);
      else stderrChunks.push(text);

      const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
      for (const line of lines) {
        syncState.logs.push({ line, stream, timestamp: Date.now() });
      }
      // limit log size to last 200 entries
      if (syncState.logs.length > 200) {
        syncState.logs.splice(0, syncState.logs.length - 200);
      }
    };

    if (child.stdout) {
      child.stdout.on('data', (data: Buffer) => capture('stdout', data));
    }
    if (child.stderr) {
      child.stderr.on('data', (data: Buffer) => capture('stderr', data));
    }

    child.on('error', (error) => {
      syncState.status = 'error';
      syncState.error = error.message;
      syncState.finishedAt = Date.now();
      const scriptError = new Error(error.message) as ScriptError;
      scriptError.stdout = stdoutChunks.join('');
      scriptError.stderr = stderrChunks.join('');
      syncState.logs.push({ line: error.message, stream: 'stderr', timestamp: Date.now() });
      if (syncState.logs.length > 200) {
        syncState.logs.splice(0, syncState.logs.length - 200);
      }
      reject(scriptError);
    });

    child.on('close', (code) => {
      const stdout = stdoutChunks.join('');
      const stderr = stderrChunks.join('');

      syncState.finishedAt = Date.now();
      if (code === 0) {
        syncState.status = 'success';
        resolve({ stdout, stderr });
      } else {
        // Extract additional error information from stderr
        const errorLines = stderr.split('\n').filter(line => line.trim().length > 0);
        const lastErrorLine = errorLines[errorLines.length - 1] || '';
        
        const baseMessage = `Sync script exited with code ${code}`;
        const detailedMessage = lastErrorLine.includes('Error:')
          ? `${baseMessage}: ${lastErrorLine}`
          : `${baseMessage}: ${stderr.trim() || 'Unbekannter Fehler'}`;
        
        syncState.status = 'error';
        syncState.error = detailedMessage;
        
        // Add detailed error information to logs
        syncState.logs.push({ line: `FEHLER: ${baseMessage}`, stream: 'stderr', timestamp: Date.now() });
        
        // Add stderr content to logs for debugging (limit to last 10 lines to avoid spam)
        const errorLogLines = errorLines.slice(-10);
        for (const line of errorLogLines) {
          if (line.trim()) {
            syncState.logs.push({ line: `STDERR: ${line}`, stream: 'stderr', timestamp: Date.now() });
          }
        }
        
        if (syncState.logs.length > 200) {
          syncState.logs.splice(0, syncState.logs.length - 200);
        }
        
        const error = new Error(detailedMessage) as ScriptError;
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

// Check if login state is valid
app.get('/api/check-login', async (req, res) => {
  try {
    const storagePath = path.join(process.cwd(), 'amazon.storageState.json');
    const exists = await fs.access(storagePath).then(() => true).catch(() => false);

    if (!exists) {
      return res.json({ valid: false, message: 'amazon.storageState.json nicht gefunden' });
    }

    // Try to read and parse the file
    const content = await fs.readFile(storagePath, 'utf-8');
    JSON.parse(content); // Check if valid JSON

    // Actually test the session by trying to access Amazon
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: storagePath });
    const page = await context.newPage();
    
    try {
      // Try to access the transactions page
      await page.goto('https://www.amazon.de/cpe/yourpayments/transactions', { 
        waitUntil: 'domcontentloaded',
        timeout: 10000 
      });
      
      // Check if we're redirected to login page
      const url = page.url();
      const title = await page.title();
      
      if (url.includes('/ap/signin') || title.includes('Anmeld')) {
        await browser.close();
        return res.json({ valid: false, message: 'Amazon-Session abgelaufen (Redirect zu Login)' });
      }
      
      // Check if we can see transactions
      const hasTransactions = await page.$('.payWalletContentContainer, [data-testid*="transaction"]').catch(() => null);
      await browser.close();
      
      if (!hasTransactions) {
        return res.json({ valid: false, message: 'Amazon-Session möglicherweise abgelaufen' });
      }
      
      res.json({ valid: true, message: 'Login-State ist gültig' });
    } catch (error) {
      await browser.close();
      throw error;
    }
  } catch (error) {
    res.json({ valid: false, message: 'Login-State ist ungültig oder beschädigt' });
  }
});

// Run login script
app.post('/api/login', async (req, res) => {
  try {
    const { stdout, stderr } = await runScript('login.ts');
    res.json({ success: true, message: 'Login erfolgreich', output: stdout, stderr });
  } catch (error) {
    const err = error as ScriptError;
    
    // Enhanced login error reporting
    const message = err.message;
    const stdout = err.stdout || '';
    const stderr = err.stderr || '';
    
    let detailedMessage = message;
    if (stderr.includes('Error:') || stderr.includes('timeout') || stderr.includes('login')) {
      const errorLines = stderr.split('\n').filter(line => line.trim());
      const relevantErrors = errorLines.slice(-3).join(' ');
      detailedMessage = `Login fehlgeschlagen: ${relevantErrors}`;
    }
    
    res.status(500).json({
      success: false,
      message: detailedMessage,
      output: stdout,
      stderr: stderr,
      debug: {
        hasStorageState: stdout.includes('storageState') || stdout.includes('StorageState'),
        hasTimeout: stderr.includes('timeout') || stdout.includes('timeout'),
        hasError: stderr.includes('Error:') || stdout.includes('Error:')
      }
    });
  }
});

// Run sync script
app.post('/api/sync', async (req, res) => {
  if (syncState.status === 'running') {
    return res.status(409).json({
      success: false,
      message: 'Sync läuft bereits.',
      status: syncState.status
    });
  }
  let syncOptions: SyncRequestOptions | undefined;
  try {
    syncOptions = normalizeSyncOptions(req.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Ungültige Synchronisierungsoptionen';
    return res.status(400).json({ success: false, message });
  }
  try {
    const { stdout, stderr } = await startSyncScript(syncOptions);
    res.json({ success: true, message: 'Sync erfolgreich', output: stdout, stderr });
  } catch (error) {
    const err = error as ScriptError;
    res.status(500).json({ success: false, message: err.message, output: err.stdout, stderr: err.stderr });
  }
});

app.get('/api/sync-status', (req, res) => {
  const { logs, ...rest } = syncState;
  res.json({
    ...rest,
    logs,
    lastLog: logs.length ? logs[logs.length - 1] : null
  });
});

app.post('/api/delete-transactions', async (req, res) => {
  const { orderIds } = req.body as { orderIds?: string[] };

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: 'orderIds array required' });
  }

  const ids = Array.from(
    new Set(
      orderIds
        .map(id => (typeof id === 'string' ? id.trim() : ''))
        .filter(id => id.length > 0)
    )
  );

  if (ids.length === 0) {
    return res.status(400).json({ error: 'orderIds array required' });
  }

  const filePath = path.join(process.cwd(), 'transactions.json');
  const exists = await fs.access(filePath).then(() => true).catch(() => false);

  if (!exists) {
    return res.status(404).json({ error: 'transactions.json nicht gefunden' });
  }

  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(raw) as {
      count: number;
      withOrderId: number;
      transactions: Transaction[];
    };

    const before = data.transactions?.length ?? 0;
    const filtered = (data.transactions ?? []).filter(t => {
      if (!t.orderId) return true;
      return !ids.includes(t.orderId);
    });
    const removed = before - filtered.length;

    if (removed === 0) {
      return res.json({ success: true, removed: 0, count: data.count, withOrderId: data.withOrderId });
    }

    const updated = {
      count: filtered.length,
      withOrderId: filtered.filter(t => !!t.orderId).length,
      transactions: filtered
    };

    await fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf8');

    res.json({ success: true, removed, count: updated.count, withOrderId: updated.withOrderId });
  } catch (error) {
    console.error('Fehler beim Löschen von Transaktionen', error);
    res.status(500).json({ error: 'Fehler beim Löschen von Transaktionen' });
  }
});

app.post('/api/reset-ynab-status', async (req, res) => {
  const { orderIds } = req.body as { orderIds?: string[] };

  if (!Array.isArray(orderIds) || orderIds.length === 0) {
    return res.status(400).json({ error: 'orderIds array required' });
  }

  const ids = Array.from(new Set(orderIds.filter(id => typeof id === 'string' && id.trim().length > 0).map(id => id.trim())));
  if (ids.length === 0) {
    return res.status(400).json({ error: 'orderIds array required' });
  }

  const filePath = path.join(process.cwd(), 'transactions.json');
  const exists = await fs.access(filePath).then(() => true).catch(() => false);
  if (!exists) {
    return res.status(404).json({ error: 'transactions.json nicht gefunden' });
  }

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw) as {
      count: number;
      withOrderId: number;
      transactions: Transaction[];
    };

    let touched = 0;
    for (const t of data.transactions) {
      if (t.orderId && ids.includes(t.orderId)) {
        if (t.ynabSynced || t.ynabSync) {
          touched++;
        }
        t.ynabSynced = false;
        delete (t as any).ynabSync;
      }
    }

    if (touched === 0) {
      return res.json({ success: true, updated: 0 });
    }

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    res.json({ success: true, updated: touched });
  } catch (error) {
    console.error('Fehler beim Zurücksetzen des YNAB-Status', error);
    res.status(500).json({ error: 'Fehler beim Zurücksetzen des YNAB-Status' });
  }
});

app.post('/api/ai-summary', async (req, res) => {
  const { text, orderId } = req.body as { text?: string; orderId?: string };

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Feld "text" ist erforderlich.' });
  }

  if (!openai) {
    return res.status(500).json({ error: 'OPENAI_API_KEY ist nicht gesetzt.' });
  }

  try {
    let summary = await summarizeWithGpt5Nano(text);
    let modelUsed = 'gpt-5-nano';

    if (!summary) {
      console.warn('[AI] Fallback auf Modell', FALLBACK_MODEL);
      summary = await summarizeWithFallbackModel(text);
      modelUsed = FALLBACK_MODEL;
    }

    if (!summary) {
      return res.status(502).json({ error: 'Keine Antwort von OpenAI erhalten.' });
    }

    const truncated = truncateSummary(summary.trim());
    res.json({ summary: truncated, model: modelUsed });
  } catch (error) {
    console.error('Fehler bei AI-Summary', error);
    const message = error instanceof Error ? error.message : 'Unbekannter Fehler';
    res.status(500).json({ error: `AI-Summary fehlgeschlagen: ${message}` });
  }
});

app.post('/api/update-ai-summary', async (req, res) => {
  const { orderId, aiSummary } = req.body as { orderId?: string; aiSummary?: string };

  if (!orderId || typeof orderId !== 'string') {
    return res.status(400).json({ error: 'orderId ist erforderlich.' });
  }

  if (aiSummary !== undefined && typeof aiSummary !== 'string') {
    return res.status(400).json({ error: 'aiSummary muss ein String sein.' });
  }

  const filePath = path.join(process.cwd(), 'transactions.json');
  const exists = await fs.access(filePath).then(() => true).catch(() => false);
  if (!exists) {
    return res.status(404).json({ error: 'transactions.json nicht gefunden' });
  }

  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const data = JSON.parse(raw) as {
      count: number;
      withOrderId: number;
      transactions: Transaction[];
    };

    let updated = false;
    for (const t of data.transactions) {
      if (t.orderId === orderId) {
        t.aiSummary = aiSummary || null;
        updated = true;
        break;
      }
    }

    if (!updated) {
      return res.status(404).json({ error: 'Transaktion mit dieser orderId nicht gefunden.' });
    }

    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');
    res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Aktualisieren der AI-Summary', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren der AI-Summary' });
  }
});

// Get transactions
app.get('/api/transactions', async (req, res) => {
  try {
    const filePath = path.join(process.cwd(), 'transactions.json');
    const exists = await fs.access(filePath).then(() => true).catch(() => false);

    if (!exists) {
      return res.json({ transactions: [], count: 0, withOrderId: 0 });
    }

    const content = await fs.readFile(filePath, 'utf-8');
    const data = JSON.parse(content);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Laden der Transaktionen' });
  }
});

// Sync selected transactions to YNAB
app.post('/api/sync-ynab', async (req, res) => {
  try {
    // Check YNAB configuration first
    const ynabConfig = checkYnabConfig();
    if (!ynabConfig.configured) {
      return res.status(400).json({
        success: false,
        error: 'YNAB nicht konfiguriert',
        message: `Fehlende Konfiguration: ${ynabConfig.missing.join(', ')}. Bitte erstelle eine .env Datei mit YNAB_TOKEN und YNAB_ACCOUNT_ID.`,
        configurationHelp: {
          missing: ynabConfig.missing,
          instructions: [
            '1. Kopiere .env.example zu .env',
            '2. Hole deinen YNAB Personal Access Token von: https://app.youneedabudget.com/settings/developer',
            '3. Finde deine YNAB Account ID in der YNAB URL oder über die API',
            '4. Trage beide Werte in die .env Datei ein',
            '5. Starte den Server neu'
          ]
        }
      });
    }

    const { transactionIds }: { transactionIds: string[] } = req.body;

    if (!transactionIds || !Array.isArray(transactionIds)) {
      return res.status(400).json({ error: 'transactionIds array required' });
    }

    const uniqueIds = Array.from(
      new Set(
        transactionIds
          .filter((id) => typeof id === 'string')
          .map((id) => id.trim())
          .filter((id) => id.length > 0)
      )
    );

    const args: string[] = [];
    if (uniqueIds.length > 0) {
      args.push('--orders', JSON.stringify(uniqueIds));
    }

    console.log('[API] /api/sync-ynab angefordert', {
      requested: uniqueIds.length,
      sample: uniqueIds.slice(0, 10)
    });

    const { stdout, stderr } = await runScript('ynab-sync.ts', args);
    const { summary, cleanedStdout } = extractYnabSummary(stdout);

    if (summary) {
      console.log('[API] YNAB Sync Summary', summary);
    }

    res.json({ success: true, message: 'YNAB Sync erfolgreich', output: cleanedStdout, stderr: stderr.trim(), summary });
  } catch (error) {
    const err = error as ScriptError;
    const { summary, cleanedStdout } = extractYnabSummary(err.stdout || '');

    if (summary) {
      console.error('[API] YNAB Sync Fehlerzusammenfassung', summary);
    }

    // Enhanced error reporting for YNAB sync
    const errorMessage = err.message;
    const stderrLines = (err.stderr || '').split('\n').filter(line => line.trim().length > 0);
    const lastErrorLine = stderrLines[stderrLines.length - 1] || '';
    
    // More detailed error analysis
    let detailedError = errorMessage;
    if (lastErrorLine && !lastErrorLine.includes('Script exited with code')) {
      detailedError = `${errorMessage}: ${lastErrorLine}`;
    } else if (stderrLines.length > 0) {
      // Look for specific YNAB error patterns
      const ynabErrorPatterns = [
        /YNAB HTTP (\d+):/,
        /bitte.*setzen/i,
        /token/i,
        /budget/i,
        /account/i,
        /permission/i
      ];
      
      for (const pattern of ynabErrorPatterns) {
        const match = stderrLines.join(' ').match(pattern);
        if (match) {
          detailedError = `${errorMessage}: ${match[0]}`;
          break;
        }
      }
    }
    
    res.status(500).json({
      success: false,
      message: detailedError,
      output: cleanedStdout,
      stderr: (err.stderr || '').trim(),
      summary,
      debug: {
        code: err.message.includes('code 1') ? 1 : undefined,
        stderrLines: stderrLines.slice(-5), // Last 5 error lines
        hasYnabError: stderrLines.some(line => /YNAB|HTTP|token|budget|account/i.test(line))
      }
    });
  }
});

// Start server with Playwright check
async function startServer() {
  await checkPlaywrightInstallation();
  
  app.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error('Fehler beim Starten des Servers:', error);
  process.exit(1);
});
