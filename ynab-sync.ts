import fs from "fs";
import path from "path";
import https from "https";
import { amountToMilliunits, parseGermanDateToISO, parseIdList } from "./ynab-utils";

const YNAB_TOKEN = process.env.YNAB_TOKEN;
const YNAB_BUDGET_ID = process.env.YNAB_BUDGET_ID || "last-used"; // "last-used" ist erlaubt
const YNAB_ACCOUNT_ID = process.env.YNAB_ACCOUNT_ID;

const INPUT_FILE = path.resolve("transactions.json");
const DRY_RUN = process.env.DRY_RUN === "1";
const DEBUG_SYNC = process.env.DEBUG_SYNC === "1";
const YNAB_HTTP_TIMEOUT_MS = Number(process.env.YNAB_HTTP_TIMEOUT_MS || 15000);
const MAX_YNAB_ERROR_BODY_LENGTH = 1000;

if (!YNAB_TOKEN || !YNAB_ACCOUNT_ID) {
  console.error("Bitte YNAB_TOKEN und YNAB_ACCOUNT_ID als ENV setzen.");
  process.exit(1);
}

const SUMMARY_SAMPLE_LIMIT = 5;

function redact(value: string): string {
  const secrets = [YNAB_TOKEN, YNAB_ACCOUNT_ID].filter((secret): secret is string => Boolean(secret));
  let redacted = value;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [redacted]");
}

function compactErrorBody(body: string): string {
  const trimmed = redact(body.replace(/\s+/g, " ").trim());
  if (trimmed.length <= MAX_YNAB_ERROR_BODY_LENGTH) return trimmed;
  return `${trimmed.slice(0, MAX_YNAB_ERROR_BODY_LENGTH).trimEnd()}...`;
}

function writeJsonAtomicSync(filePath: string, data: unknown): void {
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), "utf8");
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

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
  orderSummary?: {
    total?: string | null;
    subtotal?: string | null;
    shipping?: string | null;
    voucher?: string | null;
    bonusPoints?: string | null;
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
        if (res.statusCode && res.statusCode >= 300 && data.length > MAX_YNAB_ERROR_BODY_LENGTH * 4) {
          req.destroy(new Error("YNAB response body too large"));
        }
      });
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve(JSON.parse(data || "{}"));
          } catch {
            resolve({});
          }
        } else {
          reject(new Error(`YNAB HTTP ${res.statusCode}: ${compactErrorBody(data || res.statusMessage || "")}`));
        }
      });
    });
    req.setTimeout(YNAB_HTTP_TIMEOUT_MS, () => {
      req.destroy(new Error(`YNAB request timed out after ${YNAB_HTTP_TIMEOUT_MS}ms`));
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

      // Expand selection: If any part of a multi-order transaction is selected,
      // ensure the primary transaction (orderIndex 0) is also selected.
      const multiOrderGroups = new Map<string, any[]>();

      // Group by unique key for the transaction bundle (date + totalAmount)
      for (const t of transactions) {
        if ((t as any).multiOrderTransaction === true && t.date && (t as any).totalAmount) {
          const key = `${t.date}|${(t as any).totalAmount}`;
          if (!multiOrderGroups.has(key)) {
            multiOrderGroups.set(key, []);
          }
          multiOrderGroups.get(key)!.push(t);
        }
      }

      for (const group of multiOrderGroups.values()) {
        const groupIds = group.map(t => t.orderId).filter(Boolean);
        const hasSelection = groupIds.some((id: string) => selectedOrderIdSet.has(id));

        if (hasSelection) {
          // Find primary transaction (orderIndex 0)
          const primary = group.find(t => t.orderIndex === 0);
          if (primary && primary.orderId && !selectedOrderIdSet.has(primary.orderId)) {
            logInfo(`Automatisch primäre Transaktion hinzugefügt für Split: ${primary.orderId}`);
            selectedOrderIdSet.add(primary.orderId);

            // Also ensure the primary is NOT marked as "not-found" in the status map
            if (selectionStatusMap && selectionStatusMap.has(primary.orderId)) {
              selectionStatusMap.delete(primary.orderId);
              // It will be re-added as "queued" later if processed
            }
          }
        }
      }
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

      const payload: YnabSyncPayload & { subtransactions?: any[] } = {
        account_id: YNAB_ACCOUNT_ID,
        date: candidate.isoDate,
        amount: amountMilli,
        payee_name: candidate.merchant || "Amazon",
        memo,
        cleared: "cleared",
        approved: false,
        import_id: importId,
      };

      // For multi-order transactions, verify if we can build valid subtransactions
      if (multiOrderFlag && totalOrders && totalOrders > 1 && orderId) {
        // Find all related orders
        const relatedOrders = transactions.filter((t: any) =>
          t.multiOrderTransaction === true &&
          t.date === candidate.date &&
          t.totalAmount === (candidate as any).totalAmount
        ).sort((a: any, b: any) => (a.orderIndex || 0) - (b.orderIndex || 0));

        // Attempt to build subtransactions
        let subSum = 0;
        const potentialSubs: any[] = [];
        const isMainRefund = !!candidate.isRefund;

        for (const order of relatedOrders) {
          const totalStr = order.orderSummary?.total; // e.g. "14,99"
          if (!totalStr) continue;

          // Use main transaction sign logic
          // If main amount is negative (outflow), subs should be negative (outflow)
          // unless specific logic dictates otherwise. Amazon multi-order is usually all purchases.
          const subMilli = amountToMilliunits(totalStr, isMainRefund);
          // But wait, amountToMilliunits assumes positive string "14,99" -> 14990. 
          // If main transaction is "charge", we need NEGATIVE.
          // totalAmount is "-129.59" -> -129590.

          // We need to match the sign of the MAIN transaction amount (amountMilli)
          // amountMilli is usually negative for purchases. 
          // amountToMilliunits("14,99", false) -> 14990 (positive).
          // We need to invert it if amountMilli is negative.

          let finalSubMilli = subMilli;
          if (amountMilli < 0) {
            finalSubMilli = -Math.abs(subMilli);
          } else {
            finalSubMilli = Math.abs(subMilli);
          }

          subSum += finalSubMilli;

          const firstItem = order.orderItems?.[0]?.title || order.orderId || "Unbekannt";
          const itemPreview = firstItem.length > 50 ? firstItem.slice(0, 50) + "..." : firstItem;

          potentialSubs.push({
            amount: finalSubMilli,
            memo: `[${(order as any).orderIndex + 1}] ${itemPreview}`
          });
        }

        // Verify sum with small tolerance for float math or rounding
        if (potentialSubs.length === relatedOrders.length && Math.abs(subSum - amountMilli) <= 10) {
          payload.subtransactions = potentialSubs;
          // If we have subtransactions, we might want to keep the main memo simple?
          // user wanted "better representation", splits IS better.
        } else {
          logInfo(`Note: Subtransactions sum (${subSum}) mismatch with total (${amountMilli}) or missing data. Falling back to simple memo.`);
        }
      }

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

      // Mark sibling multi-order transactions (secondary parts) as synced
      if ((item.original as any).multiOrderTransaction === true && orderId) {
        // Find siblings based on group key (date + totalAmount)
        // Since we are iterating strictly, we can scan the full list or use a helper map if performance matters.
        // For simplicity, let's scan.
        const siblings = transactions.reduce((acc: number[], t, idx) => {
          if ((t as any).multiOrderTransaction === true &&
            t.date === item.original.date &&
            (t as any).totalAmount === (item.original as any).totalAmount &&
            (t as any).orderIndex !== (item.original as any).orderIndex) {
            acc.push(idx);
          }
          return acc;
        }, []);

        for (const siblingIdx of siblings) {
          const sibling = parsed.transactions[siblingIdx];
          // Only mark if not already marked (though here we overwrite to link to THIS sync event)
          sibling.ynabSynced = true;
          sibling.ynabSync = {
            at: new Date().toISOString(),
            importId: `${item.importId}:split:${(sibling as any).orderIndex}`,
            ynabTransactionId: matchedId, // Link to the same primary transaction ID
            duplicateImportId: false,
            amountMilliunits: amountToMilliunits(sibling.amount, false) // This might be wrong logic for amount, but it's just metadata
          };
          // Note: sibling.amount is null for multi-order usually? No, it's null in my memory, let's check.
          // In debug output: amount: null. So amountMilliunits will be 0.
          // We should use orderSummary.total if available.
          const siblingTotal = (sibling as any).orderSummary?.total;
          if (siblingTotal) {
            // Use same sign logic as main transaction if possible, or just parse.
            // Main transaction is usually outflow (-). Sibling order total is positive string "14,99".
            // We want to record the partial amount.
            let subMilli = amountToMilliunits(siblingTotal, false);
            if (item.amountMilli < 0) subMilli = -Math.abs(subMilli);
            else subMilli = Math.abs(subMilli);

            (sibling.ynabSync as any).amountMilliunits = subMilli;
          }

          const sibOrderId = typeof sibling.orderId === "string" ? sibling.orderId.trim() : null;
          if (sibOrderId && selectionStatusMap?.has(sibOrderId)) {
            selectionStatusMap.set(sibOrderId, {
              status: "synced",
              detail: "Teil einer Multi-Order-Transaktion (Split)"
            });
          }
        }
      }
    }

    summary.response.missingImportIds = missingImportIds;

    writeJsonAtomicSync(INPUT_FILE, parsed);
    logInfo(`Sync erfolgreich, Datei aktualisiert (${INPUT_FILE}).`);

    summary.selection = buildSelectionSummary(selectionStatusMap);
    console.log(`[YNAB][SUMMARY] ${JSON.stringify(summary)}`);
    console.log(`✅ Sync fertig. Datei aktualisiert: ${INPUT_FILE}`);
  } catch (error: any) {
    const message = error?.message || String(error);

    // Enhanced error logging for better debugging
    console.error("=== YNAB SYNC FEHLER ===");
    console.error("Error Message:", redact(message));
    console.error("Error Type:", error?.constructor?.name || 'Unknown');
    if (DEBUG_SYNC) {
      console.error("Stack Trace:", redact(error?.stack || 'No stack trace available'));
    }

    // Log environment information for debugging
    console.error("=== ENVIRONMENT ===");
    console.error("YNAB_TOKEN exists:", !!YNAB_TOKEN);
    console.error("YNAB_BUDGET_ID configured:", !!YNAB_BUDGET_ID);
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

    summary.response.error = redact(message);
    console.error("=== SYNC SUMMARY AT ERROR ===");
    summary.selection = buildSelectionSummary(selectionStatusMap);
    console.log(`[YNAB][SUMMARY] ${JSON.stringify(summary, null, 2)}`);
    console.error("=== END ERROR LOG ===");
    process.exit(2);
  }
})();
