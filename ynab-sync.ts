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
  const numeric = amountStr.replace(/[^\d,]/g, "").replace(",", ".");
  const value = parseFloat(numeric || "0");
  return Math.round(sign * value * 1000);
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

    const candidates: CandidateRecord[] = [];
    const retrySeed = Date.now();

    transactions.forEach((transaction, index) => {
      const orderId = typeof transaction.orderId === "string" ? transaction.orderId.trim() : null;
      const sampleId = orderId || `index-${index}`;

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

      const record: CandidateRecord = { ...transaction, __index: index, isoDate };
      candidates.push(record);

      if (orderId && selectionStatusMap?.has(orderId)) {
        selectionStatusMap.set(orderId, { status: "queued" });
      }
    });

    summary.candidates.count = candidates.length;

    const prepared = candidates.map((candidate) => {
      const amountMilli = amountToMilliunits(candidate.amount, !!candidate.isRefund);
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

      const payload: YnabSyncPayload = {
        account_id: YNAB_ACCOUNT_ID,
        date: candidate.isoDate,
        amount: amountMilli,
        payee_name: candidate.merchant || "Amazon",
        memo:
          candidate.aiSummary ||
          (candidate.orderDescription ? candidate.orderDescription.slice(0, 200) : ""),
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
    }

    summary.response.missingImportIds = missingImportIds;

    fs.writeFileSync(INPUT_FILE, JSON.stringify(parsed, null, 2), "utf8");
    logInfo(`Sync erfolgreich, Datei aktualisiert (${INPUT_FILE}).`);

    summary.selection = buildSelectionSummary(selectionStatusMap);
    console.log(`[YNAB][SUMMARY] ${JSON.stringify(summary)}`);
    console.log(`✅ Sync fertig. Datei aktualisiert: ${INPUT_FILE}`);
  } catch (error: any) {
    const message = error?.message || String(error);
    summary.response.error = message;
    console.error("YNAB Sync fehlgeschlagen:", message);
    summary.selection = buildSelectionSummary(selectionStatusMap);
    console.log(`[YNAB][SUMMARY] ${JSON.stringify(summary)}`);
    process.exit(2);
  }
})();
