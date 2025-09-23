import fs from "fs";
import path from "path";
import https from "https";

// Configuration loaded from .env file
const YNAB_TOKEN = process.env.YNAB_TOKEN;
const YNAB_BUDGET_ID = process.env.YNAB_BUDGET_ID || "last-used"; // "last-used" is allowed
const YNAB_ACCOUNT_ID = process.env.YNAB_ACCOUNT_ID;

const INPUT_FILE = path.resolve("transactions.json"); // your Amazon transactions
const DRY_RUN = process.env.DRY_RUN === "1";           // for testing: don't send to YNAB

if (!YNAB_TOKEN || !YNAB_ACCOUNT_ID) {
  console.error("Bitte YNAB_TOKEN und YNAB_ACCOUNT_ID als ENV setzen.");
  process.exit(1);
}

// ==== Helpers ====
const deMonths: Record<string, string> = {
  januar: "01", februar: "02", märz: "03", maerz: "03", april: "04", mai: "05",
  juni: "06", juli: "07", august: "08", september: "09", oktober: "10", november: "11", dezember: "12",
};

function parseGermanDateToISO(d: string): string | null {
  // z.B. "17. September 2025"
  const m = d.trim().toLowerCase().match(/^(\d{1,2})\.\s*([a-zäöüß]+)\s+(\d{4})$/i);
  if (!m) return null;
  const day = m[1].padStart(2, "0");
  const monKey = m[2].normalize("NFD").replace(/\p{Diacritic}/gu, "") // "märz" -> "marz"
                  .replace("marz","maerz");
  const month = deMonths[monKey] || deMonths[m[2]]; // versuchen mit/ohne Diakritika
  if (!month) return null;
  return `${m[3]}-${month}-${day}`;
}

function amountToMilliunits(amountStr: string, isRefundFlag: boolean): number {
  // Beispiele: "-EUR 4,99"  "+EUR 24,48"  "EUR 12,36"
  const isPositive = amountStr.includes("+") || isRefundFlag;
  const sign = isPositive ? 1 : -1;
  const numeric = amountStr
    .replace(/[^\d,]/g, "")     // nur Ziffern und Komma
    .replace(",", ".");         // deutsches Komma -> Punkt
  const value = parseFloat(numeric || "0");
  // milliunits = EUR * 1000, kaufmännisch runden
  return Math.round(sign * value * 1000);
}

function inCurrentMonth(isoDate: string): boolean {
  const now = new Date();
  const d = new Date(isoDate);
  return d.getUTCFullYear() === now.getUTCFullYear() && d.getUTCMonth() === now.getUTCMonth();
}

async function httpPostJSON(url: string, body: any, token: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const { hostname, pathname, search, protocol } = new URL(url);
    const options: https.RequestOptions = {
      method: "POST",
      hostname,
      path: pathname + (search || ""),
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${token}`,
        "Accept": "application/json",
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
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

// ==== Main ====
(async () => {
  const raw = fs.readFileSync(INPUT_FILE, "utf8");
  const parsed = JSON.parse(raw) as {
    transactions: Array<{
      date: string;
      amount: string;
      merchant?: string | null;
      isRefund?: boolean;
      orderId?: string | null;
      orderUrl?: string | null;
      orderDescription?: string | null;
      aiSummary?: string | null;
      ynabSynced?: boolean;
      ynabSync?: any;
    }>;
  };

  // 1) transform + filtern (aktueller Monat, nicht schon synced)
  const candidates = parsed.transactions
    .map((t, idx) => {
      const iso = parseGermanDateToISO(t.date);
      return { ...t, __index: idx, isoDate: iso };
    })
    .filter(t => !!t.isoDate && inCurrentMonth(t.isoDate!))
    .filter(t => {
      if (!t.ynabSynced) return true;
      const ynabInfo = t.ynabSync as { ynabTransactionId?: string | null } | undefined;
      return !ynabInfo?.ynabTransactionId;
    });

  // 2) Mapping ins YNAB-Format
  const ynabTx = candidates.map((t) => {
    const amountMilli = amountToMilliunits(t.amount, !!t.isRefund);
    const payee_name = t.merchant || "Amazon";

    // import_id hilft Duplikate zu vermeiden (max. 36 Zeichen, oft Muster: "API:amount:isoDate:counter")
    // Bei Retries (wenn ynabTransactionId null ist) neuen import_id verwenden, um gelöschte Transaktionen neu anzulegen
    const import_id = t.ynabSync && !t.ynabSync.ynabTransactionId
      ? `AMZ:${amountMilli}:${t.isoDate}:r${Date.now().toString().slice(-6)}`
      : `AMZ:${amountMilli}:${t.isoDate}`;

    // Use AI summary as memo, fallback to order description (YNAB prefers concise memos)
    const memo = t.aiSummary || (t.orderDescription ? t.orderDescription.slice(0, 200) : "");

    return {
      account_id: YNAB_ACCOUNT_ID,
      date: t.isoDate,                // YYYY-MM-DD
      amount: amountMilli,            // milliunits, Ausgaben negativ
      payee_name,
      memo,
      cleared: "cleared",             // oder "uncleared"
      approved: false,                // du kannst auch true setzen
      import_id
    };
  });

  if (ynabTx.length === 0) {
    console.log("Nichts zu syncen (aktueller Monat bereits leer oder alles synced).");
    process.exit(0);
  }

  console.log(`Bereite ${ynabTx.length} Transaktionen für YNAB vor…`);

  if (DRY_RUN) {
    console.log(JSON.stringify({ preview: ynabTx }, null, 2));
    process.exit(0);
  }

  // 3) Senden: POST /budgets/{budget_id}/transactions (einzeln ODER mehrere in einem Rutsch)
  //    Die API erlaubt "Create a single transaction or multiple transactions" per gleicher Route.
  //    Wir senden alle auf einmal: { transactions: [...] }
  const url = `https://api.ynab.com/v1/budgets/${encodeURIComponent(YNAB_BUDGET_ID)}/transactions`;
  const payload = { transactions: ynabTx };

  try {
    const resp = await httpPostJSON(url, payload, YNAB_TOKEN);
    // Antwort enthält üblicherweise die erzeugten Transaktionen.
    // Wir mappen sie anhand import_id zurück.
    const created = (resp?.data?.transactions ?? []) as Array<{ id: string; import_id?: string }>;
    const byImportId = new Map<string, string>();
    for (const tr of created) {
      if (tr.import_id) byImportId.set(tr.import_id, tr.id);
    }

    // 4) Markiere in der Original-JSON als synced
    for (const t of candidates) {
      const idx = (t as any).__index as number;
      const importId = `AMZ:${amountToMilliunits(t.amount, !!t.isRefund)}:${t.isoDate}`;
      parsed.transactions[idx].ynabSynced = true;
      parsed.transactions[idx].ynabSync = {
        at: new Date().toISOString(),
        importId,
        ynabTransactionId: byImportId.get(importId) || null,
      };
    }

    fs.writeFileSync(INPUT_FILE, JSON.stringify(parsed, null, 2), "utf8");
    console.log(`✅ Sync fertig. Datei aktualisiert: ${INPUT_FILE}`);
  } catch (err: any) {
    console.error("YNAB Sync fehlgeschlagen:", err?.message || err);
    process.exit(2);
  }
})();
