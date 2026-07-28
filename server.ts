import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { spawn, execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { chromium } from 'playwright';
import type { NextFunction, Request, Response } from 'express';

const app = express();
const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '127.0.0.1';
const API_AUTH_TOKEN = process.env.API_AUTH_TOKEN;
const API_DEBUG_OUTPUT = process.env.API_DEBUG_OUTPUT === '1';
const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'http://localhost:5174',
  'http://127.0.0.1:5174'
];
const ALLOWED_ORIGINS = (process.env.CORS_ORIGIN || DEFAULT_ALLOWED_ORIGINS.join(','))
  .split(',')
  .map(origin => origin.trim())
  .filter(Boolean);
const DEFAULT_SCRIPT_TIMEOUT_MS = Number(process.env.SCRIPT_TIMEOUT_MS || 30 * 60 * 1000);
const LOGIN_SCRIPT_TIMEOUT_MS = Number(process.env.LOGIN_SCRIPT_TIMEOUT_MS || 10 * 60 * 1000);
const YNAB_SCRIPT_TIMEOUT_MS = Number(process.env.YNAB_SCRIPT_TIMEOUT_MS || 3 * 60 * 1000);
const MAX_ORDER_IDS = Number(process.env.MAX_ORDER_IDS || 500);
const MAX_ORDER_ID_LENGTH = Number(process.env.MAX_ORDER_ID_LENGTH || 80);
const MAX_AI_INPUT_LENGTH = Number(process.env.MAX_AI_INPUT_LENGTH || 4000);
const TRANSACTIONS_FILE = path.join(process.cwd(), 'transactions.json');

// Check if Playwright is properly installed
async function checkPlaywrightInstallation(): Promise<void> {
  try {
    const result = execSync('npx playwright --version', { encoding: 'utf8' });
    console.log('✅ Playwright gefunden:', result.trim());

    try {
      await fs.access(chromium.executablePath());
      console.log('✅ Chromium Browser ist installiert');
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

function sanitizeText(value: string, maxLength = 1000): string {
  const secrets = [process.env.YNAB_TOKEN, process.env.OPENAI_API_KEY, API_AUTH_TOKEN]
    .filter((secret): secret is string => Boolean(secret));
  let sanitized = value;
  for (const secret of secrets) {
    sanitized = sanitized.split(secret).join('[redacted]');
  }
  sanitized = sanitized
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|token|authorization)["'\s:=]+[A-Za-z0-9._~+/=-]+/gi, '$1=[redacted]');
  return sanitized.length > maxLength ? `${sanitized.slice(0, maxLength).trimEnd()}...` : sanitized;
}

function clientMessage(message: string): string {
  return sanitizeText(message.replace(/\s+/g, ' ').trim(), 500);
}

function sanitizeLogLine(line: string): string {
  return sanitizeText(line, 700);
}

function extractUsefulError(stderr = '', fallback = 'Der Vorgang ist fehlgeschlagen.'): string {
  const lines = stderr.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const relevant = [...lines].reverse().find(line => /error|fehler|timeout|captcha|ynab|login|token|budget|account/i.test(line));
  return clientMessage(relevant || fallback);
}

function debugOutput(text: string): string | undefined {
  if (!API_DEBUG_OUTPUT || !text.trim()) return undefined;
  return sanitizeText(text.trim(), 8000);
}

function requireApiKey(req: Request, res: Response, next: NextFunction) {
  if (!API_AUTH_TOKEN) {
    next();
    return;
  }

  const headerToken = req.header('x-api-key');
  const authHeader = req.header('authorization');
  const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice('Bearer '.length) : undefined;

  if (headerToken === API_AUTH_TOKEN || bearerToken === API_AUTH_TOKEN) {
    next();
    return;
  }

  res.status(401).json({ error: 'Nicht autorisiert.' });
}

function normalizeOrderIds(raw: unknown, fieldName: string): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`${fieldName} array required`);
  }
  if (raw.length > MAX_ORDER_IDS) {
    throw new Error(`Maximal ${MAX_ORDER_IDS} Order-IDs pro Anfrage erlaubt.`);
  }

  const ids = Array.from(
    new Set(
      raw
        .map(id => (typeof id === 'string' ? id.trim() : ''))
        .filter(Boolean)
    )
  );

  if (ids.length === 0) {
    throw new Error(`${fieldName} array required`);
  }
  const invalid = ids.find(id => id.length > MAX_ORDER_ID_LENGTH);
  if (invalid) {
    throw new Error(`Order-ID ist zu lang: ${invalid.slice(0, 24)}...`);
  }
  return ids;
}

function isClientInputError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /array required|Maximal|Order-ID|erforderlich|ungültig|zu lang/i.test(error.message);
}

async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.writeFile(tempPath, contents, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

type TransactionsFileData = {
  count: number;
  withOrderId: number;
  transactions: Transaction[];
};

function chooseDetailCheckOrderId(data: TransactionsFileData | null): string | null {
  const transactions = data?.transactions ?? [];
  const missingDetails = transactions.find(transaction =>
    transaction.orderId &&
    (!transaction.orderDescription || !transaction.orderItems?.length || (transaction as any).detailsStatus === 'reauth-required')
  );
  const anyOrder = transactions.find(transaction => transaction.orderId);
  return missingDetails?.orderId ?? anyOrder?.orderId ?? null;
}

function validateTransactionsData(data: unknown): TransactionsFileData {
  if (!data || typeof data !== 'object' || !Array.isArray((data as any).transactions)) {
    throw new Error('transactions.json hat ein ungültiges Format.');
  }
  const transactions = (data as any).transactions as Transaction[];
  return {
    ...(data as any),
    count: transactions.length,
    withOrderId: transactions.filter(t => Boolean(t?.orderId)).length,
    transactions
  };
}

async function readTransactionsFile(): Promise<TransactionsFileData | null> {
  const exists = await fs.access(TRANSACTIONS_FILE).then(() => true).catch(() => false);
  if (!exists) return null;
  const raw = await fs.readFile(TRANSACTIONS_FILE, 'utf8');
  return validateTransactionsData(JSON.parse(raw));
}

let transactionsFileQueue: Promise<unknown> = Promise.resolve();

function withTransactionsFileLock<T>(operation: () => Promise<T>): Promise<T> {
  const run = transactionsFileQueue.then(operation, operation);
  transactionsFileQueue = run.catch(() => undefined);
  return run;
}

// Middleware
app.use(cors({
  origin(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(new Error('CORS origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key']
}));
app.use(express.json({ limit: '256kb' }));
app.use('/api', requireApiKey);

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
    manuallyMarked?: boolean;
  } | null;
}

type ScriptResult = {
  stdout: string;
  stderr: string;
};

type ScriptError = Error & ScriptResult;

type ScriptRunOptions = {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
};

type SyncStatus = {
  status: 'idle' | 'running' | 'success' | 'error';
  startedAt?: number;
  finishedAt?: number;
  logs: { line: string; stream: 'stdout' | 'stderr'; timestamp: number }[];
  error?: string | null;
};

type SyncRequestOptions = {
  mode?: 'current-month' | 'newest' | 'last-n' | 'date-range';
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
    if (raw.mode === 'current-month' || raw.mode === 'newest' || raw.mode === 'last-n' || raw.mode === 'date-range') {
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

// Helper function to run scripts with a hard deadline.
function runScript(scriptPath: string, args: string[] = [], options: ScriptRunOptions = {}): Promise<ScriptResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutMs = options.timeoutMs ?? DEFAULT_SCRIPT_TIMEOUT_MS;
    const child = spawn('npx', ['ts-node', scriptPath, ...args], {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: options.env ?? process.env
    });

    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const scriptError = new Error(`Zeitlimit von ${Math.round(timeoutMs / 1000)}s überschritten.`) as ScriptError;
      scriptError.stdout = stdoutChunks.join('');
      scriptError.stderr = stderrChunks.join('');
      reject(scriptError);
    }, timeoutMs);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

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
      finish(() => {
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');
        const scriptError = new Error(error.message) as ScriptError;
        scriptError.stdout = stdout;
        scriptError.stderr = stderr;
        reject(scriptError);
      });
    });

    child.on('close', (code) => {
      finish(() => {
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
  });
}

function buildYnabScriptEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    NODE_ENV: process.env.NODE_ENV,
    YNAB_TOKEN: process.env.YNAB_TOKEN,
    YNAB_BUDGET_ID: process.env.YNAB_BUDGET_ID,
    YNAB_ACCOUNT_ID: process.env.YNAB_ACCOUNT_ID,
    DRY_RUN: process.env.DRY_RUN
  };
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
    line: sanitizeLogLine(`[SYNC] Starte Sync mit Argumenten: ${args.slice(1).join(' ') || 'standard'}`),
    stream: 'stdout',
    timestamp: Date.now()
  });
  if (syncState.logs.length > 200) {
    syncState.logs.splice(0, syncState.logs.length - 200);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    const child = spawn('npx', args, {
      cwd: process.cwd(),
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32'
    });

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const message = `Sync hat das Zeitlimit von ${Math.round(DEFAULT_SCRIPT_TIMEOUT_MS / 1000)}s überschritten.`;
      syncState.status = 'error';
      syncState.error = message;
      syncState.finishedAt = Date.now();
      syncState.logs.push({ line: message, stream: 'stderr', timestamp: Date.now() });
      const error = new Error(message) as ScriptError;
      error.stdout = stdoutChunks.join('');
      error.stderr = stderrChunks.join('');
      reject(error);
    }, DEFAULT_SCRIPT_TIMEOUT_MS);

    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };

    const capture = (stream: 'stdout' | 'stderr', data: Buffer) => {
      const text = data.toString();
      if (stream === 'stdout') stdoutChunks.push(text);
      else stderrChunks.push(text);

      const lines = text.split(/\r?\n/).filter(line => line.trim().length > 0);
      for (const line of lines) {
        syncState.logs.push({ line: sanitizeLogLine(line), stream, timestamp: Date.now() });
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
      finish(() => {
        syncState.status = 'error';
        syncState.error = clientMessage(error.message);
        syncState.finishedAt = Date.now();
        const scriptError = new Error(error.message) as ScriptError;
        scriptError.stdout = stdoutChunks.join('');
        scriptError.stderr = stderrChunks.join('');
        syncState.logs.push({ line: clientMessage(error.message), stream: 'stderr', timestamp: Date.now() });
        if (syncState.logs.length > 200) {
          syncState.logs.splice(0, syncState.logs.length - 200);
        }
        reject(scriptError);
      });
    });

    child.on('close', (code) => {
      finish(() => {
        const stdout = stdoutChunks.join('');
        const stderr = stderrChunks.join('');

        syncState.finishedAt = Date.now();
        if (code === 0) {
          syncState.status = 'success';
          resolve({ stdout, stderr });
        } else {
          const errorLines = stderr.split('\n').filter(line => line.trim().length > 0);
          const baseMessage = `Sync script exited with code ${code}`;
          const detailedMessage = `${baseMessage}: ${extractUsefulError(stderr, 'Unbekannter Fehler')}`;
          
          syncState.status = 'error';
          syncState.error = clientMessage(detailedMessage);
          syncState.logs.push({ line: `FEHLER: ${baseMessage}`, stream: 'stderr', timestamp: Date.now() });
          
          const errorLogLines = errorLines.slice(-10);
          for (const line of errorLogLines) {
            if (line.trim()) {
              syncState.logs.push({ line: `STDERR: ${sanitizeLogLine(line)}`, stream: 'stderr', timestamp: Date.now() });
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
  });
}

// Check if login state is valid for both payments and order details.
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
    const transactionsData = await readTransactionsFile().catch(() => null);
    const detailOrderId = chooseDetailCheckOrderId(transactionsData);

    // Actually test the session by trying to access Amazon
    const playwright = await import('playwright');
    const browser = await playwright.chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: storagePath });
    const page = await context.newPage();
    
    try {
      await page.goto('https://www.amazon.de/cpe/yourpayments/transactions', { 
        waitUntil: 'domcontentloaded',
        timeout: 10000 
      });
      
      const paymentsUrl = page.url();
      const paymentsTitle = await page.title();
      const paymentsSignedOut = paymentsUrl.includes('/ap/signin') || paymentsTitle.includes('Anmeld');
      const hasTransactions = !paymentsSignedOut
        ? await page.$('.payWalletContentContainer, [data-testid*="transaction"]').catch(() => null)
        : null;

      const payments = {
        valid: Boolean(!paymentsSignedOut && hasTransactions),
        message: paymentsSignedOut
          ? 'Zahlungsübersicht verlangt Login'
          : hasTransactions
            ? 'Zahlungsübersicht ist erreichbar'
            : 'Zahlungsübersicht konnte nicht bestätigt werden'
      };

      let details = {
        valid: false,
        message: 'Keine Order-ID für Detailprüfung gefunden',
        orderId: detailOrderId
      };
      
      if (detailOrderId) {
        const detailUrl = `https://www.amazon.de/gp/css/summary/edit.html?orderID=${encodeURIComponent(detailOrderId)}`;
        await page.goto(detailUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => undefined);
        await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => undefined);
        const detailCurrentUrl = page.url();
        const detailTitle = await page.title().catch(() => '');
        const hasLoginForm = (await page.locator('form#ap_signin_form').count().catch(() => 0)) > 0;
        const hasOrderDetails = (await page.locator('#orderDetails, #od-container, #a-page #od-content').count().catch(() => 0)) > 0;
        const detailSignedOut = /\/ap\/signin/i.test(detailCurrentUrl) || hasLoginForm || /(^Anmelden\b|Anmelden\s*·\s*Amazon)/i.test(detailTitle);
        details = {
          valid: Boolean(!detailSignedOut && hasOrderDetails),
          message: detailSignedOut
            ? 'Bestelldetails verlangen Reauth'
            : hasOrderDetails
              ? 'Bestelldetails sind erreichbar'
              : 'Bestelldetails konnten nicht bestätigt werden',
          orderId: detailOrderId
        };
      }

      await browser.close();

      const valid = payments.valid && details.valid;
      const message = valid
        ? 'Amazon-Session ist vollständig gültig'
        : payments.valid
          ? 'Zahlungen ok, Bestelldetails brauchen Reauth'
          : 'Amazon-Session ist nicht vollständig gültig';
      res.json({ valid, message, payments, details });
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
    const { stdout, stderr } = await runScript('login.ts', [], { timeoutMs: LOGIN_SCRIPT_TIMEOUT_MS });
    res.json({
      success: true,
      message: 'Login erfolgreich',
      output: debugOutput(stdout),
      stderr: debugOutput(stderr)
    });
  } catch (error) {
    const err = error as ScriptError;

    res.status(500).json({
      success: false,
      message: `Login fehlgeschlagen: ${extractUsefulError(err.stderr, err.message)}`,
      output: debugOutput(err.stdout || ''),
      stderr: debugOutput(err.stderr || '')
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
    res.json({
      success: true,
      message: 'Sync erfolgreich',
      output: debugOutput(stdout),
      stderr: debugOutput(stderr)
    });
  } catch (error) {
    const err = error as ScriptError;
    res.status(500).json({
      success: false,
      message: clientMessage(err.message),
      output: debugOutput(err.stdout || ''),
      stderr: debugOutput(err.stderr || '')
    });
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
  try {
    const ids = normalizeOrderIds((req.body as { orderIds?: unknown }).orderIds, 'orderIds');
    const result = await withTransactionsFileLock(async () => {
      const data = await readTransactionsFile();
      if (!data) return { missing: true as const };

      const before = data.transactions.length;
      const filtered = data.transactions.filter(t => !t.orderId || !ids.includes(t.orderId));
      const removed = before - filtered.length;

      if (removed === 0) {
        return { missing: false as const, removed: 0, count: data.count, withOrderId: data.withOrderId };
      }

      const updated = validateTransactionsData({ ...data, transactions: filtered });
      await writeFileAtomic(TRANSACTIONS_FILE, JSON.stringify(updated, null, 2));
      return { missing: false as const, removed, count: updated.count, withOrderId: updated.withOrderId };
    });

    if (result.missing) {
      return res.status(404).json({ error: 'transactions.json nicht gefunden' });
    }
    res.json({ success: true, removed: result.removed, count: result.count, withOrderId: result.withOrderId });
  } catch (error) {
    console.error('Fehler beim Löschen von Transaktionen', error);
    const status = isClientInputError(error) ? 400 : 500;
    res.status(status).json({ error: error instanceof Error ? clientMessage(error.message) : 'Fehler beim Löschen von Transaktionen' });
  }
});

app.post('/api/reset-ynab-status', async (req, res) => {
  try {
    const ids = normalizeOrderIds((req.body as { orderIds?: unknown }).orderIds, 'orderIds');
    const result = await withTransactionsFileLock(async () => {
      const data = await readTransactionsFile();
      if (!data) return { missing: true as const };

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

      if (touched > 0) {
        const updated = validateTransactionsData(data);
        await writeFileAtomic(TRANSACTIONS_FILE, JSON.stringify(updated, null, 2));
      }
      return { missing: false as const, updated: touched };
    });

    if (result.missing) {
      return res.status(404).json({ error: 'transactions.json nicht gefunden' });
    }
    res.json({ success: true, updated: result.updated });
  } catch (error) {
    console.error('Fehler beim Zurücksetzen des YNAB-Status', error);
    const status = isClientInputError(error) ? 400 : 500;
    res.status(status).json({ error: error instanceof Error ? clientMessage(error.message) : 'Fehler beim Zurücksetzen des YNAB-Status' });
  }
});

app.post('/api/ai-summary', async (req, res) => {
  const { text, orderId } = req.body as { text?: string; orderId?: string };

  if (!text || typeof text !== 'string') {
    return res.status(400).json({ error: 'Feld "text" ist erforderlich.' });
  }

  if (text.length > MAX_AI_INPUT_LENGTH) {
    return res.status(413).json({ error: `Text ist zu lang (max. ${MAX_AI_INPUT_LENGTH} Zeichen).` });
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

  if (!orderId || typeof orderId !== 'string' || orderId.length > MAX_ORDER_ID_LENGTH) {
    return res.status(400).json({ error: 'orderId ist erforderlich.' });
  }

  if (aiSummary !== undefined && (typeof aiSummary !== 'string' || aiSummary.length > SUMMARY_MAX_LENGTH)) {
    return res.status(400).json({ error: 'aiSummary muss ein String sein.' });
  }

  try {
    const result = await withTransactionsFileLock(async () => {
      const data = await readTransactionsFile();
      if (!data) return { missing: true as const, updated: false };

      let updated = false;
      for (const t of data.transactions) {
        if (t.orderId === orderId.trim()) {
          t.aiSummary = aiSummary || null;
          updated = true;
          break;
        }
      }

      if (updated) {
        const next = validateTransactionsData(data);
        await writeFileAtomic(TRANSACTIONS_FILE, JSON.stringify(next, null, 2));
      }
      return { missing: false as const, updated };
    });

    if (result.missing) {
      return res.status(404).json({ error: 'transactions.json nicht gefunden' });
    }
    if (!result.updated) {
      return res.status(404).json({ error: 'Transaktion mit dieser orderId nicht gefunden.' });
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Fehler beim Aktualisieren der AI-Summary', error);
    res.status(500).json({ error: 'Fehler beim Aktualisieren der AI-Summary' });
  }
});

// Get transactions
app.get('/api/transactions', async (req, res) => {
  try {
    const data = await readTransactionsFile();
    if (!data) {
      return res.json({ transactions: [], count: 0, withOrderId: 0 });
    }
    res.json(data);
  } catch (error) {
    console.error('Fehler beim Laden der Transaktionen', error);
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

    let uniqueIds: string[];
    try {
      uniqueIds = normalizeOrderIds((req.body as { transactionIds?: unknown }).transactionIds, 'transactionIds');
    } catch (error) {
      const message = error instanceof Error ? clientMessage(error.message) : 'transactionIds array required';
      return res.status(400).json({ success: false, message });
    }

    const args: string[] = [];
    args.push('--orders', JSON.stringify(uniqueIds));

    console.log('[API] /api/sync-ynab angefordert', {
      requested: uniqueIds.length,
      sample: uniqueIds.slice(0, 10)
    });

    const { stdout, stderr } = await runScript('ynab-sync.ts', args, {
      timeoutMs: YNAB_SCRIPT_TIMEOUT_MS,
      env: buildYnabScriptEnv()
    });
    const { summary, cleanedStdout } = extractYnabSummary(stdout);

    if (summary) {
      console.log('[API] YNAB Sync Summary', summary);
    }

    res.json({
      success: true,
      message: 'YNAB Sync erfolgreich',
      output: debugOutput(cleanedStdout),
      stderr: debugOutput(stderr),
      summary
    });
  } catch (error) {
    const err = error as ScriptError;
    const { summary, cleanedStdout } = extractYnabSummary(err.stdout || '');

    if (summary) {
      console.error('[API] YNAB Sync Fehlerzusammenfassung', summary);
    }

    const stderrLines = (err.stderr || '').split('\n').filter(line => line.trim().length > 0);
    const detailedError = extractUsefulError(err.stderr, err.message);
    
    res.status(500).json({
      success: false,
      message: detailedError,
      output: debugOutput(cleanedStdout),
      stderr: debugOutput(err.stderr || ''),
      summary,
      debug: API_DEBUG_OUTPUT ? {
        code: err.message.includes('code 1') ? 1 : undefined,
        stderrLines: stderrLines.slice(-5).map(sanitizeLogLine),
        hasYnabError: stderrLines.some(line => /YNAB|HTTP|token|budget|account/i.test(line))
      } : undefined
    });
  }
});

// Start server with Playwright check
async function startServer() {
  await checkPlaywrightInstallation();
  
  app.listen(PORT, HOST, () => {
    console.log(`Server läuft auf http://${HOST}:${PORT}`);
    if (!API_AUTH_TOKEN) {
      console.warn('API_AUTH_TOKEN ist nicht gesetzt; API-Schutz ist deaktiviert.');
    }
  });
}

startServer().catch((error) => {
  console.error('Fehler beim Starten des Servers:', error);
  process.exit(1);
});
