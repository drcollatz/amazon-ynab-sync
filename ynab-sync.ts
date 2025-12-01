import fs from "fs";
import path from "path";
import https from "https";

const YNAB_TOKEN = process.env.YNAB_TOKEN;
const YNAB_BUDGET_ID = process.env.YNAB_BUDGET_ID || "last-used"; // "last-used" ist erlaubt
const YNAB_ACCOUNT_ID = process.env.YNAB_ACCOUNT_ID;

const INPUT_FILE = path.resolve("transactions.json");
const DRY_RUN = process.env.DRY_RUN === "1";

if (!YNAB_TOKEN || !YNAB_ACCOUNT_ID) {
  console.error("Bitte YNAB_TOKEN und YNAB_ACCOUNT_ID als ENV setzen.");
  process.exit(1);
}

const SUMMARY_SAMPLE_LIMIT = 5;

type FilterEntry = { count: number; examples: string[] };
type SelectionStatus =
  | "queued"
  | "synced"
  | "already-synced"
  | "invalid-date"
  | "not-found";

interface SelectionStatusEntry {
  status: SelectionStatus;
  detail?: string;
}

interface SyncSummarySelection {
  provided: number;
  queuedIds: string[];
  syncedIds: string[];
  alreadySynced: string[];
  invalidDate: string[];
  missingIds: string[];
  statuses: Record<string, SelectionStatusEntry>;
}

interface SyncSummary {
  timestamp: string;
  dryRun: boolean;
  totals: {
    fileTransactions: number;
    withOrderId: number;
    withValidDate: number;
    eligibleBeforeSelection: number;
  };
  filters: {
    invalidDate: FilterEntry;
    alreadySynced: FilterEntry;
  };
  flags: {
    ynabSyncedWithoutId: FilterEntry;
  };
  candidates: {
    count: number;
    refunds: number;
    totalAmountMilliunits: number;
  };
  response: {
    requested: number;
    created: number;
    duplicateImportIds: string[];
    missingImportIds: string[];
    matchedImportIds: number;
    error?: string;
  };
  selection?: SyncSummarySelection;
}

type ParsedTransaction = {
  date: string;
  amount: string;
  paymentInstrument?: string | null;
  merchant?: string | null;
  orderId?: string | null;
  orderUrl?: string | null;
  isRefund?: boolean;
  orderDescription?: string | null;
  orderTitles?: string[] | null;
  orderItems?: { title: string; price?: string | null }[] | null;
  aiSummary?: string | null;
  ynabSynced?: boolean;
  ynabSync?: {
    at?: string;
    importId?: string | null;
    ynabTransactionId?: string | null;
    duplicateImportId?: boolean;
    amountMilliunits?: number;
  } | null;
};

type CandidateRecord = ParsedTransaction & { __index: number; isoDate: string };

type YnabResponse = {
  data?: {
    transactions?: Array<{ id: string; import_id?: string | null }>;
    duplicate_import_ids?: string[];
  };
};

type YnabSyncPayload = {
  account_id: string;
  date: string;
  amount: number;
  payee_name: string;
  memo: string;
  cleared: "cleared" | "uncleared";
  approved: boolean;
  import_id: string;
};

const deMonths: Record<string, string> = {
  januar: "01",
  februar: "02",
  märz: "03",
  maerz: "03",
  april: "04",
  mai: "05",
  juni: "06",
  juli: "07",
  august: "08",
  september: "09",
  oktober: "10",
  november: "11",
  dezember: "12",
};

function makeFilterEntry(): FilterEntry {
  return { count: 0, examples: [] };
}

function recordFilter(entry: FilterEntry, sample?: string | null) {
  entry.count += 1;
  if (sample && entry.examples.length < SUMMARY_SAMPLE_LIMIT) {
    entry.examples.push(sample);
  }
}

function normalizeId(id: string): string {
  return id.trim();
}

function parseIdList(raw: string | undefined): string[] {
  if (!raw) return [];
  const value = raw.trim();
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => (typeof item === "string" ? item : String(item)));
    }
  } catch {
    // ignore invalid JSON, fall back to comma-separated parsing
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function parseCliOrderIds(argv: string[]): string[] {
  const collected: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--order" && argv[i + 1]) {
      collected.push(argv[i + 1]);
      i += 1;
      continue;
    }
    if (arg?.startsWith("--order=")) {
      collected.push(arg.slice("--order=".length));
      continue;
    }
    if (arg === "--orders" && argv[i + 1]) {
      collected.push(...parseIdList(argv[i + 1]));
      i += 1;
      continue;
    }
    if (arg?.startsWith("--orders=")) {
      collected.push(...parseIdList(arg.slice("--orders=".length)));
    }
  }
  return collected;
}

function buildSelectionSummary(map: Map<string, SelectionStatusEntry> | undefined): SyncSummarySelection | undefined {
  if (!map || map.size === 0) return undefined;
  const queuedIds: string[] = [];
  const syncedIds: string[] = [];
  const alreadySynced: string[] = [];
  const invalidDate: string[] = [];
  const missingIds: string[] = [];
  const statuses: Record<string, SelectionStatusEntry> = {};

  for (const [orderId, entry] of map.entries()) {
    statuses[orderId] = entry;
    switch (entry.status) {
      case "queued":
        queuedIds.push(orderId);
        break;
      case "synced":
        syncedIds.push(orderId);
        break;
      case "already-synced":
        alreadySynced.push(orderId);
        break;
      case "invalid-date":
        invalidDate.push(orderId);
        break;
      case "not-found":
        missingIds.push(orderId);
        break;
      default:
        break;
    }
  }

  return {
    provided: map.size,
    queuedIds,
    syncedIds,
    alreadySynced,
    invalidDate,
    missingIds,
    statuses,
  };
}

const cliOrderIds = parseCliOrderIds(process.argv.slice(2));
const envOrderIds = parseIdList(process.env.YNAB_SELECTED_ORDER_IDS);
const selectedOrderIds = Array.from(new Set([...envOrderIds, ...cliOrderIds].map(normalizeId))).filter(Boolean);
const selectedOrderIdSet = selectedOrderIds.length ? new Set(selectedOrderIds) : undefined;

function logInfo(message: string, data?: unknown) {
  if (data === undefined) {
    console.log(`[YNAB] ${message}`);
  } else {
    console.log(`[YNAB] ${message}`, data);
  }
}

function parseGermanDateToISO(d: string): string | null {
  const m = d.trim().toLowerCase().match(/^(\d{1,2})\.\s*([a-zäöüß]+)\s+(\d{4})$/i);
  if (!m) return null;
  const day = m[1].padStart(2, "0");
  const monKey = m[2]
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace("marz", "maerz");
  const month = deMonths[monKey] || deMonths[m[2]];
  if (!month) return null;
  return `${m[3]}-${month}-${day}`;
}

function amountToMilliunits(amountStr: string, isRefundFlag: boolean): number {
  const isPositive = amountStr.includes("+") || isRefundFlag;
  const sign = isPositive ? 1 : -1;
  
  // Handle both German (€,) and English (€.) format
  const cleanAmount = amountStr.replace(/[^\d,.-]/g, "");
  let numeric: number;
  
  if (cleanAmount.includes(",") && !cleanAmount.includes(".")) {
    // German format: "19,94" -> "19.94"
    numeric = parseFloat(cleanAmount.replace(",", "."));
  } else if (cleanAmount.includes(".") && !cleanAmount.includes(",")) {
    // English format: "19.94" -> 19.94
    numeric = parseFloat(cleanAmount);
  } else if (cleanAmount.includes(",") && cleanAmount.includes(".")) {
    // Both present - assume last occurrence is decimal separator
    const lastComma = cleanAmount.lastIndexOf(",");
    const lastDot = cleanAmount.lastIndexOf(".");
    if (lastComma > lastDot) {
      // German format with thousands separator: "1.234,56" -> "1234.56"
      numeric = parseFloat(cleanAmount.replace(/\./g, "").replace(",", "."));
    } else {
      // English format with thousands separator: "1,234.56" -> "1234.56"
      numeric = parseFloat(cleanAmount.replace(/,/g, ""));
    }
  } else {
    // No separators, just digits
    numeric = parseFloat(cleanAmount);
  }
  
  return Math.round(sign * numeric * 1000);
}

async function httpPostJSON(url: string, body: any, token: string): Promise<YnabResponse> {
  return new Promise((resolve, reject) => {
    const { hostname, pathname, search } = new URL(url);
    const options: https.RequestOptions = {
      method: "POST",
      hostname,
      path: pathname + (search || ""),
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => {
        data += chunk;
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch {
            resolve({});
          }
        } else {
          reject(new Error(`YNAB HTTP ${res.statusCode}: ${data}`));
        }
      });
    });
    req.on("error", reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

(async () => {
const summary: SyncSummary = {
  timestamp: new Date().toISOString(),
  dryRun: DRY_RUN,
  totals: {
    fileTransactions: 0,
    withOrderId: 0,
    withValidDate: 0,
    eligibleBeforeSelection: 0,
  },
  filters: {
    invalidDate: makeFilterEntry(),
    alreadySynced: makeFilterEntry(),
  },
    flags: {
      ynabSyncedWithoutId: makeFilterEntry(),
    },
    candidates: {
      count: 0,
      refunds: 0,
      totalAmountMilliunits: 0,
    },
    response: {
      requested: 0,
      created: 0,
      duplicateImportIds: [],
      missingImportIds: [],
      matchedImportIds: 0,
    },
  };

  const selectionStatusMap = selectedOrderIdSet ? new Map<string, SelectionStatusEntry>() : undefined;
  if (selectionStatusMap && selectedOrderIdSet) {
    for (const id of selectedOrderIdSet) {
      selectionStatusMap.set(id, { status: "not-found" });
    }
  }

  try {
    const raw = fs.readFileSync(INPUT_FILE, "utf8");
    const parsed = JSON.parse(raw) as { transactions: ParsedTransaction[] };
    const transactions = Array.isArray(parsed.transactions) ? parsed.transactions : [];

    summary.totals.fileTransactions = transactions.length;
    logInfo(`Geladene Transaktionen: ${summary.totals.fileTransactions}`);

    if (selectedOrderIdSet) {
      logInfo(`Eingeschränkter Sync auf ${selectedOrderIdSet.size} Order-IDs`, {
        preview: Array.from(selectedOrderIdSet).slice(0, 20),
      });
    }

    // Group transactions by orderId to identify Santander-Punkte companions
    const transactionsByOrderId = new Map<string, Array<{ transaction: ParsedTransaction; index: number }>>();
    
    transactions.forEach((transaction, index) => {
      const orderId = typeof transaction.orderId === "string" ? transaction.orderId.trim() : null;
      if (orderId) {
        if (!transactionsByOrderId.has(orderId)) {
          transactionsByOrderId.set(orderId, []);
        }
        transactionsByOrderId.get(orderId)!.push({ transaction, index });
      }
    });

    const candidates: CandidateRecord[] = [];
    const retrySeed = Date.now();
    const santanderPunkteIndices = new Set<number>(); // Track which indices are Santander-Punkte transactions

    transactions.forEach((transaction, index) => {
      const orderId = typeof transaction.orderId === "string" ? transaction.orderId.trim() : null;
      const sampleId = orderId || `index-${index}`;
      const isSantanderPunkte = transaction.paymentInstrument?.includes('Santander-Punkte') ?? false;

      if (orderId) {
        summary.totals.withOrderId += 1;
      }

      const isoDate = transaction.date ? parseGermanDateToISO(transaction.date) : null;
      if (!isoDate) {
        recordFilter(summary.filters.invalidDate, sampleId);
        if (orderId && selectionStatusMap?.has(orderId)) {
          selectionStatusMap.set(orderId, { status: "invalid-date" });
        }
        return;
      }

      summary.totals.withValidDate += 1;

      const completedYnabSync = Boolean(transaction.ynabSynced && (transaction.ynabSync as any)?.ynabTransactionId);
      if (completedYnabSync) {
        recordFilter(summary.filters.alreadySynced, sampleId);
        if (orderId && selectionStatusMap?.has(orderId)) {
          selectionStatusMap.set(orderId, { status: "already-synced" });
        }
        return;
      }

      summary.totals.eligibleBeforeSelection += 1;

      if (transaction.ynabSynced && !(transaction.ynabSync as any)?.ynabTransactionId) {
        recordFilter(summary.flags.ynabSyncedWithoutId, sampleId);
      }

      if (selectedOrderIdSet && (!orderId || !selectedOrderIdSet.has(orderId))) {
        return;
      }

      // Skip Santander-Punkte transactions - they will be added to main transaction memo
      if (isSantanderPunkte) {
        santanderPunkteIndices.add(index);
        logInfo(`Überspringe Santander-Punkte Transaktion: ${sampleId} (${transaction.amount})`);
        return;
      }

      // Skip secondary multi-order transactions - only sync the primary one (orderIndex === 0)
      const isMultiOrder = (transaction as any).multiOrderTransaction === true;
      const orderIndex = (transaction as any).orderIndex;
      if (isMultiOrder && orderIndex !== 0) {
        logInfo(`Überspringe sekundäre Multi-Order Transaktion: ${sampleId} (Teil ${orderIndex + 1})`);
        if (orderId && selectionStatusMap?.has(orderId)) {
          selectionStatusMap.set(orderId, { 
            status: "already-synced", 
            detail: "Teil einer Multi-Order-Transaktion (nicht primär)" 
          });
        }
        return;
      }

      const record: CandidateRecord = { ...transaction, __index: index, isoDate };
      candidates.push(record);

      if (orderId && selectionStatusMap?.has(orderId)) {
        selectionStatusMap.set(orderId, { status: "queued" });
      }
    });

    summary.candidates.count = candidates.length;

    const prepared = candidates.map((candidate) => {
      // For multi-order transactions, use totalAmount instead of amount
      const isMultiOrder = (candidate as any).multiOrderTransaction === true;
      const amountStr = isMultiOrder ? ((candidate as any).totalAmount || candidate.amount) : candidate.amount;
      
      const amountMilli = amountToMilliunits(amountStr, !!candidate.isRefund);
      summary.candidates.totalAmountMilliunits += amountMilli;
      if (candidate.isRefund) {
        summary.candidates.refunds += 1;
      }

      const existing = candidate.ynabSync as { ynabTransactionId?: string | null } | undefined;
      const baseImportId = `AMZ:${amountMilli}:${candidate.isoDate}`;
      let importId = baseImportId;

      if (existing && !existing.ynabTransactionId) {
        const suffix = ((retrySeed + candidate.__index) % 1679616).toString(36).padStart(3, "0");
        importId = `${baseImportId}:r${suffix}`;
        if (importId.length > 36) {
          importId = importId.slice(0, 36);
        }
      }

      // Build memo with Santander-Punkte info if applicable
      let memo = candidate.aiSummary ||
        (candidate.orderDescription ? candidate.orderDescription.slice(0, 200) : "");
      
      // Check if there's a Santander-Punkte transaction for the same order
      const orderId = typeof candidate.orderId === "string" ? candidate.orderId.trim() : null;
      
      // For multi-order transactions, append details about all orders
      const multiOrderFlag = (candidate as any).multiOrderTransaction === true;
      const totalOrders = (candidate as any).totalOrders;
      if (multiOrderFlag && totalOrders && totalOrders > 1 && orderId) {
        // Find all related orders from the same date
        const relatedOrders = transactions.filter((t: any) => 
          t.multiOrderTransaction === true && 
          t.date === candidate.date &&
          t.totalAmount === (candidate as any).totalAmount
        );
        
        if (relatedOrders.length > 1) {
          const orderSummaries = relatedOrders
            .sort((a: any, b: any) => (a.orderIndex || 0) - (b.orderIndex || 0))
            .map((order: any, idx: number) => {
              const orderTotal = order.orderSummary?.total || "?";
              const firstItem = order.orderItems?.[0]?.title || order.orderId || "Unbekannt";
              const itemPreview = firstItem.length > 40 ? firstItem.slice(0, 40) + "..." : firstItem;
              return `[${idx + 1}] ${itemPreview} (${orderTotal}€)`;
            })
            .join(" | ");
          
          memo = `Multi-Order: ${orderSummaries}`;
        }
      }
      
      if (orderId && transactionsByOrderId.has(orderId)) {
        const relatedTransactions = transactionsByOrderId.get(orderId)!;
        const santanderTransaction = relatedTransactions.find(
          rt => rt.transaction.paymentInstrument?.includes('Santander-Punkte')
        );
        
        if (santanderTransaction) {
          const punkteAmount = santanderTransaction.transaction.amount || "0";
          // Append Santander-Punkte info to memo
          const punkteInfo = ` [Santander-Punkte: ${punkteAmount}]`;
          const maxMemoLength = 200 - punkteInfo.length;
          if (memo.length > maxMemoLength) {
            memo = memo.slice(0, maxMemoLength);
          }
          memo += punkteInfo;
        }
      }

      const payload: YnabSyncPayload = {
        account_id: YNAB_ACCOUNT_ID,
        date: candidate.isoDate,
        amount: amountMilli,
        payee_name: candidate.merchant || "Amazon",
        memo,
        cleared: "cleared",
        approved: false,
        import_id: importId,
      };

      return {
        original: candidate,
        amountMilli,
        importId,
        payload,
      };
    });

    summary.response.requested = prepared.length;

    if (prepared.length === 0) {
      summary.selection = buildSelectionSummary(selectionStatusMap);
      console.log(`[YNAB][SUMMARY] ${JSON.stringify(summary)}`);
      console.log("Nichts zu syncen (aktueller Monat bereits leer oder alles synced).");
      process.exit(0);
    }

    if (DRY_RUN) {
      summary.selection = buildSelectionSummary(selectionStatusMap);
      console.log(JSON.stringify({ preview: prepared.map((item) => item.payload) }, null, 2));
      console.log(`[YNAB][SUMMARY] ${JSON.stringify(summary)}`);
      process.exit(0);
    }

    const url = `https://api.ynab.com/v1/budgets/${encodeURIComponent(YNAB_BUDGET_ID)}/transactions`;
    const payload = { transactions: prepared.map((item) => item.payload) };

    const resp = await httpPostJSON(url, payload, YNAB_TOKEN);
    const created = Array.isArray(resp?.data?.transactions)
      ? (resp.data?.transactions as Array<{ id: string; import_id?: string | null }>)
      : [];
    const duplicates = Array.isArray(resp?.data?.duplicate_import_ids)
      ? resp.data.duplicate_import_ids.map(String)
      : [];
    const duplicateSet = new Set(duplicates);
    const byImportId = new Map<string, string>();

    for (const tr of created) {
      if (tr.import_id && tr.id) {
        byImportId.set(tr.import_id, tr.id);
      }
    }

    summary.response.created = created.length;
    summary.response.duplicateImportIds = duplicates;
    summary.response.matchedImportIds = byImportId.size;

    const missingImportIds: string[] = [];

    for (const item of prepared) {
      const idx = item.original.__index;
      const matchedId = byImportId.get(item.importId) || null;
      const isDuplicate = duplicateSet.has(item.importId);

      if (!matchedId && !isDuplicate) {
        missingImportIds.push(item.importId);
      }

      parsed.transactions[idx].ynabSynced = true;
      parsed.transactions[idx].ynabSync = {
        at: new Date().toISOString(),
        importId: item.importId,
        ynabTransactionId: matchedId,
        duplicateImportId: isDuplicate || undefined,
        amountMilliunits: item.amountMilli,
      };

      const orderId = typeof item.original.orderId === "string" ? item.original.orderId.trim() : null;
      if (orderId && selectionStatusMap?.has(orderId)) {
        if (matchedId || isDuplicate) {
          selectionStatusMap.set(orderId, {
            status: "synced",
            detail: isDuplicate ? "duplicate-import-id" : undefined,
          });
        } else {
          selectionStatusMap.set(orderId, {
            status: "queued",
            detail: "missing-ynab-transaction-id",
          });
        }
      }
      
      // Also mark Santander-Punkte companion transactions as synced (attached to main transaction)
      if (orderId && transactionsByOrderId.has(orderId)) {
        const relatedTransactions = transactionsByOrderId.get(orderId)!;
        const santanderTransaction = relatedTransactions.find(
          rt => rt.transaction.paymentInstrument?.includes('Santander-Punkte')
        );
        
        if (santanderTransaction) {
          const santanderIdx = santanderTransaction.index;
          parsed.transactions[santanderIdx].ynabSynced = true;
          parsed.transactions[santanderIdx].ynabSync = {
            at: new Date().toISOString(),
            importId: `${item.importId}:punkte`,
            ynabTransactionId: matchedId, // Same as main transaction
            duplicateImportId: false,
            amountMilliunits: amountToMilliunits(santanderTransaction.transaction.amount, false),
          };
          logInfo(`Santander-Punkte als Teil der Haupttransaktion markiert: ${orderId}`);
        }
      }
    }

    summary.response.missingImportIds = missingImportIds;

    fs.writeFileSync(INPUT_FILE, JSON.stringify(parsed, null, 2), "utf8");
    logInfo(`Sync erfolgreich, Datei aktualisiert (${INPUT_FILE}).`);

    summary.selection = buildSelectionSummary(selectionStatusMap);
    console.log(`[YNAB][SUMMARY] ${JSON.stringify(summary)}`);
    console.log(`✅ Sync fertig. Datei aktualisiert: ${INPUT_FILE}`);
  } catch (error: any) {
    const message = error?.message || String(error);
    const stack = error?.stack || 'No stack trace available';
    
    // Enhanced error logging for better debugging
    console.error("=== YNAB SYNC FEHLER ===");
    console.error("Error Message:", message);
    console.error("Error Type:", error?.constructor?.name || 'Unknown');
    console.error("Stack Trace:", stack);
    
    // Log environment information for debugging
    console.error("=== ENVIRONMENT ===");
    console.error("YNAB_TOKEN exists:", !!YNAB_TOKEN);
    console.error("YNAB_BUDGET_ID:", YNAB_BUDGET_ID);
    console.error("YNAB_ACCOUNT_ID exists:", !!YNAB_ACCOUNT_ID);
    console.error("INPUT_FILE:", INPUT_FILE);
    console.error("File exists:", require('fs').existsSync(INPUT_FILE));
    console.error("DRY_RUN:", DRY_RUN);
    console.error("Selected Order IDs:", selectedOrderIds.length);
    
    // If it's a network/HTTP error, log more details
    if (message.includes('HTTP') || message.includes('fetch') || message.includes('network')) {
      console.error("=== NETWORK ERROR DETAILS ===");
      console.error("This appears to be a network-related error.");
      console.error("Please check your internet connection and YNAB API accessibility.");
    }
    
    // If it's an environment variable error
    if (message.includes('YNAB_TOKEN') || message.includes('environment') || !YNAB_TOKEN || !YNAB_ACCOUNT_ID) {
      console.error("=== ENVIRONMENT VARIABLE ERROR ===");
      console.error("Please ensure these environment variables are set:");
      console.error("- YNAB_TOKEN: Your YNAB personal access token");
      console.error("- YNAB_ACCOUNT_ID: Your YNAB account ID");
      console.error("Check your .env file or environment configuration.");
    }
    
    // If it's a file error
    if (message.includes('ENOENT') || message.includes('readFileSync') || message.includes('transactions.json')) {
      console.error("=== FILE ERROR ===");
      console.error("The transactions.json file could not be read.");
      console.error("This might indicate:");
      console.error("1. File doesn't exist - run transactions-to-json.ts first");
      console.error("2. File is corrupted or invalid JSON");
      console.error("3. Insufficient file permissions");
    }
    
    summary.response.error = message;
    console.error("=== SYNC SUMMARY AT ERROR ===");
    summary.selection = buildSelectionSummary(selectionStatusMap);
    console.log(`[YNAB][SUMMARY] ${JSON.stringify(summary, null, 2)}`);
    console.error("=== END ERROR LOG ===");
    process.exit(2);
  }
})();
