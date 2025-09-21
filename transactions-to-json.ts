// transactions-to-json.ts
import { chromium, devices } from "playwright";
import type { Page } from "playwright";

type Transaction = {
  date: string | null;
  amount: string | null;
  paymentInstrument: string | null;
  merchant: string | null;
  orderId: string | null;
  orderUrl: string | null;
  isRefund: boolean;
  orderDescription: string | null;          // all titles joined with " · "
  orderTitles?: string[] | null;            // optional separate titles
};

const BASE = "https://www.amazon.de";
const TRANSACTIONS_URL = `${BASE}/cpe/yourpayments/transactions`;
const DETAILS_URL = (orderId: string) => `${BASE}/gp/css/summary/edit.html?orderID=${orderId}`;

const MAX_TX = 20;                  // limit extracted transactions from first page
const HEADLESS = true;              // set false for debugging
const BLOCK_RESOURCES = true;       // block heavy resources for speed

const sanitize = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim() || null;

// Helper to check if a transaction date is in the current month
function isCurrentMonth(dateStr: string | null): boolean {
  if (!dateStr) return false;
  const now = new Date();
  const currentMonth = now.getMonth();
  const currentYear = now.getFullYear();

  // Parse German date format: "18. September 2025"
  const match = dateStr.match(/(\d{1,2})\.\s*(\w+)\s*(\d{4})/);
  if (!match) return false;

  const day = parseInt(match[1], 10);
  const monthName = match[2];
  const year = parseInt(match[3], 10);

  // Map German month names to numbers
  const monthMap: { [key: string]: number } = {
    'Januar': 0, 'Februar': 1, 'März': 2, 'April': 3, 'Mai': 4, 'Juni': 5,
    'Juli': 6, 'August': 7, 'September': 8, 'Oktober': 9, 'November': 10, 'Dezember': 11
  };

  const month = monthMap[monthName];
  if (month === undefined) return false;

  return year === currentYear && month === currentMonth;
}

// Detect typical login page strings – we never want to persist those as titles/descriptions
const isLoginText = (s?: string | null) => {
  if (!s) return false;
  return /(^|\b)Anmelden\b|Amazon\s+Anmelden/i.test(s);
};

// Scrub login artefacts from a transaction's title fields
function scrubLoginFields(t: Transaction) {
  if (isLoginText(t.orderDescription)) {
    t.orderDescription = null;
  }
  if (t.orderTitles && t.orderTitles.length > 0) {
    t.orderTitles = t.orderTitles.filter((x) => !/Anmelden/i.test(x));
    if (t.orderTitles.length === 0) t.orderTitles = null;
  }
}

async function ensureNoCaptcha(page: Page, ctx: string) {
  const hasCaptcha = await page.$('form[action*="/errors/validateCaptcha"]');
  if (hasCaptcha) throw new Error(`Captcha auf ${ctx} – bitte login.ts erneut ausführen und storageState aktualisieren.`);
}

async function slowScroll(page: Page) {
  await page.evaluate(async () => {
    await new Promise<void>((res) => {
      let y = 0;
      const id = setInterval(() => {
        y += 900;
        window.scrollTo(0, y);
        if (y >= document.body.scrollHeight) { clearInterval(id); res(); }
      }, 120);
    });
  });
}

/** Extract first page transactions (max MAX_TX) */
async function extractTransactions(page: Page): Promise<Transaction[]> {
  console.time("phase:extractTransactions");
  console.log("[1/4] Öffne Transaktionsseite...");
  await page.goto(TRANSACTIONS_URL, { waitUntil: "domcontentloaded" });
  await ensureNoCaptcha(page, "Transaktionsseite");

  console.log("   Scrolle für Lazy-Load...");
  await slowScroll(page);

  const rowSel = ".apx-transactions-line-item-component-container";
  await page.waitForSelector(rowSel, { timeout: 15000 });

  console.log("   Lese DOM und parsiere Transaktionen...");
  const txs = await page.$$eval(rowSel, (rows) => {
    const sanitize = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim() || null;

    const getPrevDate = (el: Element): string | null => {
      let p: Element | null = el.previousElementSibling;
      while (p) {
        if (p.classList.contains("apx-transaction-date-container")) {
          const span = p.querySelector("span");
          return sanitize(span?.textContent ?? "");
        }
        p = p.previousElementSibling;
      }
      let parent: Element | null = el.parentElement;
      while (parent) {
        let q: Element | null = parent.previousElementSibling;
        while (q) {
          if (q.classList.contains("apx-transaction-date-container")) {
            const span = q.querySelector("span");
            return sanitize(span?.textContent ?? "");
          }
          q = q.previousElementSibling;
        }
        parent = parent.parentElement;
      }
      return null;
    };

    return rows.slice(0, 9999).map((row) => {
      const amount =
        sanitize(row.querySelector(".a-size-base-plus.a-text-bold")?.textContent) ||
        sanitize(row.querySelector(".a-size-base.a-text-bold")?.textContent);

      const paymentInstrument =
        sanitize(row.querySelector(".a-row .a-column .a-size-base.a-text-bold")?.textContent);

      let merchant: string | null = null;
      const merchantCands = Array.from(row.querySelectorAll(".a-size-base"))
        .filter((el) => !el.classList.contains("a-text-bold"));
      if (merchantCands.length) merchant = sanitize(merchantCands[0].textContent);

      const orderLinkEl = row.querySelector<HTMLAnchorElement>('a.a-link-normal[href*="/gp/css/summary/edit.html?orderID="]');
      const orderUrl = orderLinkEl?.getAttribute("href") || null;
      const orderId = orderUrl ? (orderUrl.match(/orderID=([A-Z0-9-]+)/i)?.[1] ?? null) : null;

      const linkText = sanitize(orderLinkEl?.textContent) ?? "";
      const isRefund = /^Erstattung/i.test(linkText);

      const date = getPrevDate(row);

      return {
        date,
        amount,
        paymentInstrument,
        merchant,
        orderId,
        orderUrl: orderUrl,
        isRefund,
        orderDescription: null
      } as Transaction;
    });
  });

  // Filter out Amazon Punkte Punkte transactions as per user request
  const filtered = txs.filter(t => t.paymentInstrument !== "Amazon Punkte Punkte");
  const sliced = filtered.slice(0, MAX_TX);
  console.log(`   Gefundene Transaktionen gesamt: ${txs.length}, gefiltert: ${filtered.length}, verwende Limit ${sliced.length}`);
  console.timeEnd("phase:extractTransactions");
  return sliced;
}

/** Fetch product titles from order detail page (strictly scoped to #orderDetails) */
async function fetchOrderTitles(page: Page, orderId: string): Promise<string[] | null> {
  const label = `order:${orderId}`;
  console.time(label);

  // Navigate to details URL
  const url = DETAILS_URL(orderId);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => {});

  // Hard login/invalid-page detection BEFORE parsing any titles
  const currentUrl = page.url();
  const title = await page.title().catch(() => "");
  const hasLoginForm = (await page.locator("form#ap_signin_form").count().catch(() => 0)) > 0;
  const hasOrderDetails = (await page.locator("#orderDetails").count().catch(() => 0)) > 0;

  // Any of these indicates we are not on a valid order details page
  if (
    /\/ap\/signin/i.test(currentUrl) ||
    hasLoginForm ||
    /(^Anmelden\b|Anmelden\s*·\s*Amazon)/i.test(title) ||
    !hasOrderDetails
  ) {
    console.warn(`   Kein Zugriff auf Bestelldetails für ${orderId} (Login/Redirect oder fehlendes #orderDetails).`);
    console.timeEnd(label);
    return null;
  }

  await ensureNoCaptcha(page, `Bestelldetails (${orderId})`);

  // Strictly scope selectors to the order details container
  const detailsRoot = page.locator("#orderDetails").first();

  // Try to wait for purchased items block, but do not fail hard if it never appears
  const purchasedRoot = detailsRoot.locator('[data-component="purchasedItems"]').first();
  await purchasedRoot.waitFor({ state: "attached", timeout: 7000 }).catch(() => {});

  const titles: string[] = [];

  // 1) Primary: item title links in purchased items
  const titleLinks = detailsRoot.locator('[data-component="purchasedItems"] [data-component="itemTitle"] a.a-link-normal');
  const linkCount = await titleLinks.count().catch(() => 0);
  for (let i = 0; i < linkCount; i++) {
    const t = sanitize(await titleLinks.nth(i).textContent());
    if (t) titles.push(t);
  }

  // 2) Fallback: image alt text within purchased items
  if (titles.length === 0) {
    const imgs = detailsRoot.locator('[data-component="purchasedItems"] [data-component="itemImage"] img[alt]');
    const n = await imgs.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const alt = sanitize(await imgs.nth(i).getAttribute("alt"));
      if (alt) titles.push(alt);
    }
  }

  // 3) Last fallback: any product link within the order details area
  if (titles.length === 0) {
    const any = detailsRoot.locator('a.a-link-normal[href*="/dp/"]');
    const n = await any.count().catch(() => 0);
    for (let i = 0; i < n; i++) {
      const t = sanitize(await any.nth(i).textContent());
      if (t) titles.push(t);
    }
  }

  // Normalize and deduplicate
  const unique = Array.from(new Set(titles));

  console.timeEnd(label);
  return unique.length ? unique : null;
}

/** Block heavy resources for speed */
async function setupRequestBlocking(page: Page) {
  await page.route("**/*", (route) => {
    const type = route.request().resourceType();
    if (type === "image" || type === "media" || type === "font" || type === "stylesheet") {
      return route.abort();
    }
    return route.continue();
  });
}

async function main() {
  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    ...devices["Desktop Chrome"],
    storageState: "amazon.storageState.json",
    locale: "de-DE",
    timezoneId: "Europe/Berlin",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
  });
  const page = await context.newPage();
  if (BLOCK_RESOURCES) {
    await setupRequestBlocking(page);
  }

  console.time("total:run");

  // Step 1: Transactions
  const transactions = await extractTransactions(page);

  // Step 2: Fetch order details for current month transactions (no retroactive enrichment)
  console.log(`[2/4] Lade Details für alle Bestellungen des aktuellen Monats (ohne Nacharbeit alter Einträge)...`);
  const seenOrderIds = new Set<string>();
  let fetched = 0;
  for (const tx of transactions) {
    if (!tx.orderId) continue;
    if (seenOrderIds.has(tx.orderId)) continue;
    if (!isCurrentMonth(tx.date)) continue; // only current month

    const titles = await fetchOrderTitles(page, tx.orderId);
    // Clean and dedupe titles to avoid persisting login artefacts
    const cleaned = titles ? titles.filter((t) => !/Anmelden/i.test(t)) : null;
    const deduped = cleaned ? Array.from(new Set(cleaned)) : null;

    const related = transactions.filter(t => t.orderId === tx.orderId);
    for (const r of related) {
      r.orderTitles = deduped;
      r.orderDescription = deduped ? deduped.join(" · ") : null;
      scrubLoginFields(r);
    }
    seenOrderIds.add(tx.orderId);
    fetched++;
    await page.waitForTimeout(150);
  }

  // Step 3: Merge & write file (no enrichment for existing)
  console.log("[3/4] Schreibe transactions.json ...");
  const fs = await import("fs");
  const path = "transactions.json";

  type Persisted = {
    count: number;
    withOrderId: number;
    transactions: Transaction[];
  };

  let existing: Persisted | null = null;
  if (fs.existsSync(path)) {
    try {
      existing = JSON.parse(fs.readFileSync(path, "utf-8")) as Persisted;
    } catch (e) {
      console.warn("Bestehende transactions.json konnte nicht geparst werden – wird überschrieben.", e);
    }
  }

  const keyOf = (t: Transaction) => [t.orderId ?? "no-id", t.amount ?? "no-amount", t.date ?? "no-date"].join("|");

  // Build index of existing by key and scrub old login artefacts
  const existingArr: Transaction[] = (existing?.transactions ?? []).filter(t => t.paymentInstrument !== "Amazon Punkte Punkte");
  for (const et of existingArr) scrubLoginFields(et);
  const existingByKey = new Map<string, Transaction>(existingArr.map((t) => [keyOf(t), t]));

  // Update existing entries with fresh titles/descriptions from this run.
  // If not present yet, collect as new entries.
  const newOnes: Transaction[] = [];
  for (const t of transactions) {
    scrubLoginFields(t);
    const k = keyOf(t);
    const ex = existingByKey.get(k);
    if (ex) {
      // Prefer values from the current run if available
      if (t.orderTitles !== undefined) ex.orderTitles = t.orderTitles ?? ex.orderTitles ?? null;
      if (t.orderDescription !== undefined) ex.orderDescription = t.orderDescription ?? ex.orderDescription ?? null;
      // Ensure no login artefacts remain after merge
      scrubLoginFields(ex);
    } else {
      newOnes.push(t);
      existingByKey.set(k, t);
    }
  }

  // Keep existing order (stable) and prepend new ones (like before)
  const mergedTransactions = newOnes.concat(existingArr);

  const mergedPayload: Persisted = {
    count: mergedTransactions.length,
    withOrderId: mergedTransactions.filter(t => !!t.orderId).length,
    transactions: mergedTransactions
  };

  fs.writeFileSync(path, JSON.stringify(mergedPayload, null, 2));
  console.log("[3/4] Schreiben abgeschlossen.");

  // Step 4: Summary
  console.log("[4/4] Zusammenfassung:");
  const perDate = new Map<string, number>();
  for (const t of newOnes) {
    const d = t.date || "Unbekanntes Datum";
    perDate.set(d, (perDate.get(d) ?? 0) + 1);
  }
  if (newOnes.length === 0) {
    console.log("Keine neuen Transaktionen.");
  } else {
    console.log(`Neue Transaktionen hinzugefügt: ${newOnes.length}`);
    for (const [d, c] of perDate.entries()) {
      console.log(`  ${d}: +${c}`);
    }
  }
  console.log(`Detailseiten aus aktuellem Monat geladen: ${fetched}`);
  console.log(`Aktuelle Gesamtanzahl: ${mergedPayload.count}`);
  console.timeEnd("total:run");

  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});