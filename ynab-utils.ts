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

export type TransactionLike = {
  date?: string | null;
  amount?: string | null;
  totalAmount?: string | null;
  orderId?: string | null;
  multiOrderTransaction?: boolean;
  orderIndex?: number | null;
  paymentInstrument?: string | null;
  orderTitles?: unknown;
  orderDescription?: unknown;
  orderItems?: unknown;
  orderSummary?: unknown;
  aiSummary?: unknown;
  ynabSynced?: boolean;
  detailsStatus?: "ok" | "reauth-required" | "not-found";
  detailsCheckedAt?: string;
};

export type MergeResult<T extends TransactionLike> = {
  transactions: T[];
  newTransactions: T[];
};

export function parseIdList(raw: string | undefined): string[] {
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

export function parseGermanDateToISO(d: string): string | null {
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

export function transactionTime(transaction: TransactionLike): number {
  const isoDate = transaction.date ? parseGermanDateToISO(transaction.date) : null;
  if (!isoDate) return 0;
  return Date.parse(`${isoDate}T00:00:00.000Z`);
}

export function transactionKey(transaction: TransactionLike): string {
  const parts = [
    transaction.orderId ?? "no-id",
    transaction.amount ?? (transaction.totalAmount ?? "no-amount"),
    transaction.date ?? "no-date"
  ];
  if (transaction.multiOrderTransaction && transaction.orderIndex !== undefined && transaction.orderIndex !== null) {
    parts.push(`idx-${transaction.orderIndex}`);
  }
  return parts.join("|");
}

export function sortTransactionsNewestFirst<T extends TransactionLike>(transactions: T[]): T[] {
  return [...transactions].sort((a, b) => {
    const timeDiff = transactionTime(b) - transactionTime(a);
    if (timeDiff !== 0) return timeDiff;
    const aIndex = a.orderIndex ?? 0;
    const bIndex = b.orderIndex ?? 0;
    if (aIndex !== bIndex) return aIndex - bIndex;
    return transactionKey(a).localeCompare(transactionKey(b));
  });
}

export function mergeTransactions<T extends TransactionLike>(existing: T[], incoming: T[]): MergeResult<T> {
  const newMultiOrderRefs = new Set<string>();
  for (const transaction of incoming) {
    if (transaction.multiOrderTransaction && transaction.orderId) {
      newMultiOrderRefs.add(`${transaction.orderId}|${transaction.date ?? "no-date"}`);
    }
  }

  const retainedExisting = existing.filter((transaction) => {
    if (transaction.paymentInstrument === "Amazon Punkte Punkte" || transaction.paymentInstrument === "Santander-Punkte") {
      return false;
    }
    if (transaction.orderId?.endsWith("-")) {
      return false;
    }
    if (
      transaction.orderId &&
      !transaction.multiOrderTransaction &&
      newMultiOrderRefs.has(`${transaction.orderId}|${transaction.date ?? "no-date"}`)
    ) {
      return false;
    }
    return true;
  });

  const existingByKey = new Map<string, T>(retainedExisting.map((transaction) => [transactionKey(transaction), transaction]));
  const newTransactions: T[] = [];

  for (const transaction of incoming) {
    const key = transactionKey(transaction);
    const existingTransaction = existingByKey.get(key);
    if (existingTransaction) {
      const fields: Array<keyof TransactionLike> = [
        "orderTitles",
        "orderDescription",
        "orderItems",
        "orderSummary",
        "aiSummary",
        "detailsStatus",
        "detailsCheckedAt"
      ];
      for (const field of fields) {
        if (transaction[field] !== undefined && transaction[field] !== null) {
          (existingTransaction as any)[field] = transaction[field] ?? (existingTransaction as any)[field] ?? null;
        }
      }
    } else {
      const relatedExisting = transaction.orderId
        ? retainedExisting.find((candidate) => candidate.orderId === transaction.orderId)
        : undefined;
      if (relatedExisting) {
        const fields: Array<keyof TransactionLike> = [
          "orderTitles",
          "orderDescription",
          "orderItems",
          "orderSummary",
          "aiSummary",
          "detailsStatus",
          "detailsCheckedAt"
        ];
        for (const field of fields) {
          if (transaction[field] === undefined || transaction[field] === null) {
            (transaction as any)[field] = (relatedExisting as any)[field] ?? null;
          }
        }
      }
      newTransactions.push(transaction);
      existingByKey.set(key, transaction);
    }
  }

  return {
    transactions: sortTransactionsNewestFirst(newTransactions.concat(retainedExisting)),
    newTransactions
  };
}

export function amountToMilliunits(amountStr: string | null | undefined, isRefundFlag: boolean): number {
  if (!amountStr) return 0;
  const isPositive = amountStr.includes("+") || isRefundFlag;
  const sign = isPositive ? 1 : -1;

  const cleanAmount = amountStr.replace(/[^\d,.]/g, "");
  let numeric: number;

  if (cleanAmount.includes(",") && !cleanAmount.includes(".")) {
    numeric = parseFloat(cleanAmount.replace(",", "."));
  } else if (cleanAmount.includes(".") && !cleanAmount.includes(",")) {
    numeric = parseFloat(cleanAmount);
  } else if (cleanAmount.includes(",") && cleanAmount.includes(".")) {
    const lastComma = cleanAmount.lastIndexOf(",");
    const lastDot = cleanAmount.lastIndexOf(".");
    if (lastComma > lastDot) {
      numeric = parseFloat(cleanAmount.replace(/\./g, "").replace(",", "."));
    } else {
      numeric = parseFloat(cleanAmount.replace(/,/g, ""));
    }
  } else {
    numeric = parseFloat(cleanAmount);
  }

  if (!Number.isFinite(numeric)) return 0;
  return Math.round(sign * numeric * 1000);
}
