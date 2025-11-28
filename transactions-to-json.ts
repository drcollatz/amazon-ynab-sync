/// <reference lib="dom" />
// transactions-to-json.ts
import { chromium, devices } from "playwright";
import type { Page } from "playwright";
import OpenAI from "openai";

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
  orderItems?: OrderItem[] | null;          // structured items used for formatted description
  aiSummary?: string | null;                // AI-generated summary for YNAB memo
};

type OrderItem = {
  title: string;
  price?: string | null;
};

type SyncMode = 'current-month' | 'last-n' | 'date-range';

type CliOptions = {
  mode: SyncMode;
  lastCount?: number;
  startDate?: string;
  endDate?: string;
};

const monthMap: { [key: string]: number } = {
  'Januar': 0, 'Februar': 1, 'März': 2, 'April': 3, 'Mai': 4, 'Juni': 5,
  'Juli': 6, 'August': 7, 'September': 8, 'Oktober': 9, 'November': 10, 'Dezember': 11
};

const BASE = "https://www.amazon.de";
const TRANSACTIONS_URL = `${BASE}/cpe/yourpayments/transactions`;
const DETAILS_URL = (orderId: string) => `${BASE}/gp/your-account/order-details?orderID=${orderId}`;

const HEADLESS = true;              // set false for debugging
const BLOCK_RESOURCES = true;       // block heavy resources for speed

const sanitize = (s?: string | null) => (s ?? "").replace(/\s+/g, " ").trim() || null;

const cliOptions = parseCliOptions(process.argv.slice(2));
console.log(`[Options] Modus: ${cliOptions.mode}${cliOptions.mode === 'last-n' ? ` (letzte ${cliOptions.lastCount})` : ''}${cliOptions.mode === 'date-range' ? ` (${cliOptions.startDate ?? '?'} bis ${cliOptions.endDate ?? '?'})` : ''}`);

function parseCliOptions(argv: string[]): CliOptions {
  const options: CliOptions = { mode: 'current-month' };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--mode': {
        const value = argv[i + 1];
        if (value === 'current-month' || value === 'last-n' || value === 'date-range') {
          options.mode = value;
        }
        i++;
        break;
      }
      case '--last':
      case '--count': {
        const value = Number(argv[i + 1]);
        if (Number.isFinite(value) && value > 0) {
          options.lastCount = Math.floor(value);
        }
        i++;
        break;
      }
      case '--start': {
        const value = argv[i + 1];
        if (value) options.startDate = value;
        i++;
        break;
      }
      case '--end': {
        const value = argv[i + 1];
        if (value) options.endDate = value;
        i++;
        break;
      }
      default:
        break;
    }
  }

  if (options.mode === 'last-n') {
    options.lastCount = Math.max(options.lastCount ?? 20, 1);
  }

  if (options.mode === 'date-range' && (!options.startDate || !options.endDate)) {
    console.warn('[Optionen] Ungültiger Datumsbereich angegeben – falle auf aktuellen Monat zurück.');
    options.mode = 'current-month';
    delete options.startDate;
    delete options.endDate;
  }

  return options;
}

function formatOrderDescription(items?: OrderItem[] | null, titles?: string[] | null): string | null {
  const maxItems = 5;
  if (items && items.length > 0) {
    const parts = items.slice(0, maxItems).map((item, idx) => {
      const priceSuffix = item.price ? ` (${item.price})` : "";
      return `${idx + 1}. ${item.title}${priceSuffix}`;
    });
    if (items.length > maxItems) {
      parts.push(`+${items.length - maxItems} weitere Artikel`);
    }
    return parts.join(' | ');
  }
  if (titles && titles.length > 0) {
    const parts = titles.slice(0, maxItems).map((title, idx) => `${idx + 1}. ${title}`);
    if (titles.length > maxItems) {
      parts.push(`+${titles.length - maxItems} weitere Artikel`);
    }
    return parts.join(' | ');
  }
  return null;
}

function parseGermanDate(dateStr: string | null): Date | null {
  if (!dateStr) return null;
  const match = dateStr.match(/(\d{1,2})\.\s*(\w+)\s*(\d{4})/);
  if (!match) return null;
  const day = parseInt(match[1], 10);
  const monthName = match[2];
  const year = parseInt(match[3], 10);
  const month = monthMap[monthName];
  if (month === undefined) return null;
  return new Date(year, month, day);
}

// Helper to check if a transaction date is in the current month
function isCurrentMonth(dateStr: string | null): boolean {
  const date = parseGermanDate(dateStr);
  if (!date) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
}

function isWithinRange(dateStr: string | null, start?: string, end?: string): boolean {
  const date = parseGermanDate(dateStr);
  if (!date) return false;
  if (start) {
    const startDate = new Date(start);
    if (!Number.isNaN(startDate.getTime()) && date < startDate) return false;
  }
  if (end) {
    const endDate = new Date(end);
    if (!Number.isNaN(endDate.getTime()) && date > endDate) return false;
  }
  return true;
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
  if (t.orderItems && t.orderItems.length > 0) {
    t.orderItems = t.orderItems.filter((item) => !isLoginText(item.title));
    if (t.orderItems.length === 0) t.orderItems = null;
  }
}

async function generateSummary(description: string): Promise<string | null> {
  if (!description || description.length < 10) return null;

  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: "You are a helpful assistant that summarizes Amazon order descriptions into concise, clear memos suitable for budgeting tools like YNAB. Keep summaries under 100 characters, include all items from the description, and use German."
        },
        {
          role: "user",
          content: `Fasse diese Amazon-Bestellung zusammen: ${description}`
        }
      ],
      max_tokens: 50,
      temperature: 0.5
    });
    const summary = response.choices[0]?.message?.content?.trim();
    return summary || null;
  } catch (error) {
    console.warn("Failed to generate AI summary:", error);
    return null;
  }
}

function applySyncFilters(transactions: Transaction[], options: CliOptions): Transaction[] {
  switch (options.mode) {
    case 'last-n': {
      const count = Math.max(options.lastCount ?? 20, 1);
      return transactions.slice(0, count);
    }
    case 'date-range': {
      return transactions.filter(t => isWithinRange(t.date, options.startDate, options.endDate));
    }
    case 'current-month':
    default:
      return transactions.filter(t => isCurrentMonth(t.date));
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

/** Extract transactions from first page with dynamic limit */
async function extractTransactions(page: Page, options: CliOptions): Promise<Transaction[]> {
  console.time("phase:extractTransactions");
  console.log("[1/4] Öffne Transaktionsseite...");
  await page.goto(TRANSACTIONS_URL, { waitUntil: "domcontentloaded" });
  await ensureNoCaptcha(page, "Transaktionsseite");

  console.log("   Scrolle für Lazy-Load...");
  await slowScroll(page);

  // Multiple fallback selectors for Amazon transactions (they change their classes frequently)
  const transactionSelectors = [
    ".apx-transactions-line-item-component-container", // Legacy
    "[data-component='transactionsGrid']",              // New Amazon structure
    ".a-container:has([data-testid*='transaction'])",  // Test ID based
    "div[aria-label*='transact']",                     // ARIA label
    "li[data-testid*='order']",                        // Order-based
    ".a-container",                                    // Generic Amazon containers
    ".orders-container"                                // Orders page
  ];
  
  let selectorFound = false;
  let foundSelector = '';
  let lastError = '';
  
  // Try each selector with short timeout
  for (const selector of transactionSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 3000 });
      foundSelector = selector;
      selectorFound = true;
      console.log(`✅ Found transactions using selector: ${selector}`);
      break;
    } catch (error) {
      lastError = (error as Error).message;
      continue;
    }
  }
  
  if (!selectorFound) {
    console.error(`❌ No transaction selector found. Last error: ${lastError}`);
    console.log("Available selectors tried:", transactionSelectors);
    
    // Try a more general approach - wait for any content and debug
    try {
      await page.waitForSelector('body', { timeout: 5000 });
      console.log("🔍 Page loaded, checking for Amazon login state...");
      
      // Check if we're on login page
      const currentUrl = page.url();
      console.log("Current URL:", currentUrl);
      
      if (currentUrl.includes('signin') || currentUrl.includes('login')) {
        throw new Error("Amazon is asking for login - storage state expired or invalid");
      }
      
      // Try to find any transaction-like content
      const potentialElements = await page.$$('div, li, section, article');
      console.log(`Found ${potentialElements.length} potential elements on page`);
      
      // Look for text patterns that might indicate transactions
      const pageText = await page.textContent('body');
      if (pageText && (pageText.includes('Bestellung') || pageText.includes('order') || pageText.includes('transaction'))) {
        console.log("Found transaction-related text on page, trying general selectors...");
        selectorFound = true; // Assume we can proceed
        foundSelector = 'body'; // Use body as fallback
      } else {
        throw new Error(`No transaction content found on page. URL: ${currentUrl}`);
      }
    } catch (debugError) {
      throw new Error(`Amazon page analysis failed: ${(debugError as Error).message}`);
    }
  }
  
  console.log(`Using selector: ${foundSelector} for transaction extraction`);

  console.log("   Lese DOM und parsiere Transaktionen...");
  const maxEntries = options.mode === 'last-n'
    ? Math.max(options.lastCount ?? 20, 1)
    : 500;

  // Enhanced debug mode - let's see what we're actually working with!
  const debugInfo = await page.evaluate((selector) => {
    const results: any[] = [];
    const elements = document.querySelectorAll(selector);
    
    console.log(`[DEBUG] Found ${elements.length} elements with selector: ${selector}`);
    
    elements.forEach((el, idx) => {
      const debug = {
        index: idx,
        tagName: el.tagName,
        className: el.className,
        id: el.id,
        textContent: (el.textContent || "").substring(0, 200),
        outerHTML: (el.outerHTML || "").substring(0, 500),
        children: el.children.length,
        childTags: Array.from(el.children).map(child => ({
          tag: child.tagName,
          class: child.className,
          text: (child.textContent || "").trim().substring(0, 50)
        })),
        hrefs: Array.from(el.querySelectorAll('a[href]')).map(a => ({
          href: (a as HTMLAnchorElement).href,
          text: (a.textContent || "").trim()
        })),
        amounts: Array.from(el.querySelectorAll('.a-size-base-plus, .a-text-bold, [class*="price"], [class*="amount"]')).map(a => ({
          text: (a.textContent || "").trim(),
          class: a.className
        })),
        dates: Array.from(el.querySelectorAll('[class*="date"], [class*="zeit"], time')).map(d => ({
          text: (d.textContent || "").trim(),
          class: d.className
        })),
        merchants: Array.from(el.querySelectorAll('.a-size-base:not(.a-text-bold), [class*="merchant"], [class*="seller"]')).map(m => ({
          text: (m.textContent || "").trim(),
          class: m.className
        }))
      };
      results.push(debug);
    });
    
    return results;
  }, foundSelector);

  console.log("[DEBUG] Detailed DOM analysis of found elements:");
  debugInfo.forEach((debug, idx) => {
    console.log(`\n=== ELEMENT ${idx + 1} ===`);
    console.log(`Tag: ${debug.tagName}, Class: ${debug.className}`);
    console.log(`Text content: ${debug.textContent}`);
    console.log(`Children: ${debug.children}`);
    console.log("Child elements:");
    debug.childTags.forEach((child: any) => {
      console.log(`  - <${child.tag} class="${child.class}">${child.text}</>`);
    });
    if (debug.hrefs.length > 0) {
      console.log("Links found:");
      debug.hrefs.forEach((href: any) => {
        console.log(`  - "${href.text}" -> ${href.href}`);
      });
    }
    if (debug.amounts.length > 0) {
      console.log("Amount candidates:");
      debug.amounts.forEach((amount: any) => {
        console.log(`  - "${amount.text}" (class: ${amount.class})`);
      });
    }
    if (debug.dates.length > 0) {
      console.log("Date candidates:");
      debug.dates.forEach((date: any) => {
        console.log(`  - "${date.text}" (class: ${date.class})`);
      });
    }
    if (debug.merchants.length > 0) {
      console.log("Merchant candidates:");
      debug.merchants.forEach((merchant: any) => {
        console.log(`  - "${merchant.text}" (class: ${merchant.class})`);
      });
    }
    console.log("Raw HTML snippet (first 1000 chars):");
    console.log(debug.outerHTML);
  });
  
  console.log("\n[DEBUG] RECOMMENDATIONS:");
  console.log("Based on the analysis above, modify the transaction selectors in the code:");
  console.log("- For amounts: look for .a-size-base-plus, .a-text-bold, [class*='price']");
  console.log("- For dates: look for [class*='date'], [class*='zeit'], time elements");
  console.log("- For merchants: look for .a-size-base:not(.a-text-bold), [class*='merchant']");
  console.log("- For order IDs: look for a[href*='orderID'] links");
  console.log("Update the $eval function to use the correct selectors based on this analysis.");

  // Parse transaction data from link texts (Amazon format) 
  console.log("[TRANSACTION] Starting transaction parsing from link texts...");
  let txs: any[] = [];
  try {
    // Use the same selector as the debug analysis to find the right elements
    const linkTexts = await page.evaluate((selector) => {
      const results: Array<{text: string, href: string}> = [];
      const elements = document.querySelectorAll(selector);
      
      console.log(`[TRANSACTION] Analyzing ${elements.length} elements with selector: ${selector}`);
      
      elements.forEach((el, idx) => {
        const links = el.querySelectorAll('a[href]');
        console.log(`[TRANSACTION] Element ${idx + 1} has ${links.length} transaction links`);
        
        links.forEach((link) => {
          const text = (link.textContent || "").trim();
          const href = (link as HTMLAnchorElement).href;
          if (text && href) {
            console.log(`[TRANSACTION] Found transaction link: "${text}"`);
            results.push({text, href});
          }
        });
      });
      
      return results;
    }, foundSelector);
    
    console.log(`[TRANSACTION] Found ${linkTexts.length} total links to process`);
    
    for (let i = 0; i < linkTexts.length; i++) {
      const {text: linkText, href: linkHref} = linkTexts[i];
      console.log(`[TRANSACTION] Processing link ${i + 1}: "${linkText}"`);
      
      if (linkText && linkHref) {
        // Check if this looks like a transaction
        if (linkText.includes('Bestellnummer') && (linkText.includes('€') || /\d{1,2}\.\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)/i.test(linkText))) {
          console.log(`[TRANSACTION] Transaction detected, parsing...`);
          
          // Extract order ID
          const orderIdMatch = linkText.match(/Bestellnummer\s+([0-9-]+)/);
          const orderId = orderIdMatch ? orderIdMatch[1].replace(/-$/, '') : null;
          
          // Extract amount
          const amountMatch = linkText.match(/([+-]?€\d+[.,]\d{2})/);
          const amount = amountMatch ? amountMatch[1] : null;
          
          // Extract date
          const dateMatch = linkText.match(/(\d{1,2}\.\s*(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s*\d{4})/i);
          const date = dateMatch ? dateMatch[1] : null;
          
          // Extract merchant - improve parsing logic
          let merchant = null;
          if (date) {
            // Look for merchant between date and payment instrument
            const afterDate = linkText.substring(linkText.indexOf(date) + date.length);
            // Pattern: Date · Merchant · PaymentInstrument
            const merchantMatch = afterDate.match(/·([^·]+)·/);
            if (merchantMatch) {
              merchant = merchantMatch[1].trim();
            } else {
              // Fallback: look for any text after date that's not the payment instrument
              const parts = afterDate.split('·');
              if (parts.length > 1) {
                merchant = parts[0].trim();
              }
            }
          }
          
          // Extract payment instrument
          const cardMatch = linkText.match(/(Amazon Visa|Santander-Punkte|AMAZON|AMZN)/);
          const paymentInstrument = cardMatch ? cardMatch[1] : null;
          
          // Check if it's a refund
          const isRefund = linkText.includes('Erstattet') || amountMatch?.[1]?.startsWith('+');
          
          // Create transaction object
          if (date || amount || orderId) {
            // Generate proper order details URL since linkHref points to transaction page
            const orderUrl = orderId ? `https://www.amazon.de/gp/css/summary/edit.html?orderID=${orderId}` : linkHref;
            
            const transaction = {
              date,
              amount,
              paymentInstrument,
              merchant,
              orderId,
              orderUrl,
              isRefund,
              orderDescription: null,
              orderItems: null
            };
            
            txs.push(transaction);
            console.log(`[TRANSACTION] Added: ${orderId || 'no-id'} - ${amount} - ${merchant || 'no-merchant'}`);
          } else {
            console.log(`[TRANSACTION] Skipped - insufficient data`);
          }
        } else {
          console.log(`[TRANSACTION] Skipped - not a transaction link`);
        }
      }
    }
    
    console.log(`[TRANSACTION] Total transactions extracted: ${txs.length}`);
  } catch (error) {
    console.error("[TRANSACTION] Error during transaction parsing:", error);
    txs = [];
  }

  // Filter out Amazon Punkte Punkte transactions as per user request
  const filtered = txs.filter((t: any) => t.paymentInstrument !== "Amazon Punkte Punkte");
  const byMode = applySyncFilters(filtered, options);
  console.log(`   Gefundene Transaktionen gesamt: ${txs.length}, gefiltert: ${filtered.length}, nach Modus (${options.mode}): ${byMode.length}`);
  console.timeEnd("phase:extractTransactions");
  return byMode;
}

type OrderDetailResult = {
  titles: string[] | null;
  items: OrderItem[] | null;
};

/** Fetch product titles from order detail page (strictly scoped to #orderDetails) */
async function fetchOrderTitles(page: Page, orderId: string, orderUrl?: string | null): Promise<OrderDetailResult | null> {
  const label = `order:${orderId}`;
  console.time(label);

  // Navigate to details URL
  const url = orderUrl ?? DETAILS_URL(orderId);
  console.log(`   [Detail] Navigiere zu ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 25000 }).catch(() => {});
  await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});

  // Hard login/invalid-page detection BEFORE parsing any titles
  const currentUrl = page.url();
  const title = await page.title().catch(() => "");
  const hasLoginForm = (await page.locator("form#ap_signin_form").count().catch(() => 0)) > 0;
  let hasOrderDetails = (await page.locator("#orderDetails").count().catch(() => 0)) > 0;
  if (!hasOrderDetails) {
    await page.waitForSelector("#orderDetails, #od-container, #a-page #od-content", { timeout: 12000 }).catch(() => {});
    hasOrderDetails = (await page.locator("#orderDetails").count().catch(() => 0)) > 0;
  }

  // Any of these indicates we are not on a valid order details page
  if (
    /\/ap\/signin/i.test(currentUrl) ||
    hasLoginForm ||
    /(^Anmelden\b|Anmelden\s*·\s*Amazon)/i.test(title) ||
    !hasOrderDetails
  ) {
    console.warn(`   Kein Zugriff auf Bestelldetails für ${orderId} (Login/Redirect oder fehlendes #orderDetails). URL=${currentUrl} TITLE=${title}`);
    console.timeEnd(label);
    return null;
  }

  await ensureNoCaptcha(page, `Bestelldetails (${orderId})`);

  type RawItem = {
    title: string | null;
    price: string | null;
  };

  const { titles, items: rawItems, debugSelectors, foundRoot, rootSnippet } = await page.evaluate(() => {
    const sanitize = (t?: string | null) => (t ?? "").replace(/\s+/g, " ").trim() || null;

    const rootSelectors = [
      '#orderDetails .orderCard',
      '.orderCard',
      '[data-test-id="order-card"]',
      '#orderDetails',
      '#od-container',
      '#a-page #od-content',
      '#a-page',
      'body'
    ];

    const seenRoots = new Set<Element>();
    const roots: Element[] = [];
    for (const sel of rootSelectors) {
      const found = Array.from(document.querySelectorAll(sel));
      for (const el of found) {
        if (seenRoots.has(el)) continue;
        seenRoots.add(el);
        roots.push(el);
      }
      if (roots.length) break; // prefer first selector with hits
    }

    const seen = new Set<string>();
    const titles: string[] = [];
    const items: RawItem[] = [];
    const debugSelectors: { selector: string; hits: number }[] = [];

    const pushTitle = (raw: string | null | undefined) => {
      const clean = sanitize(raw);
      if (!clean) return;
      if (/^Bestellung\b/i.test(clean)) return;
      if (/^Lieferung\b/i.test(clean)) return;
      if (/^Bestellungsdetails$/i.test(clean)) return;
      if (!seen.has(clean)) {
        seen.add(clean);
        titles.push(clean);
      }
    };

    const rootsToUse = roots.length ? roots : [document.body];

    let purchasedHits = 0;
    for (const root of rootsToUse) {
      const purchasedSections = Array.from(root.querySelectorAll('[data-component="purchasedItems"]'));
      if (!purchasedSections.length) continue;
      for (const section of purchasedSections) {
        const itemBlocks = Array.from(section.querySelectorAll('[data-component="purchasedItemsRightGrid"]'));
        for (const block of itemBlocks) {
          const titleNode = block.querySelector('[data-component="itemTitle"] a');
          const priceNode = block.querySelector('[data-component="unitPrice"] .a-price');
          const titleText = sanitize(titleNode?.textContent);
          if (!titleText) continue;
          pushTitle(titleText);
          let priceText: string | null = null;
          if (priceNode) {
            const hidden = priceNode.querySelector('[aria-hidden="true"]');
            const offscreen = priceNode.querySelector('.a-offscreen');
            priceText = sanitize(hidden?.textContent) || sanitize(offscreen?.textContent) || sanitize(priceNode.textContent);
          }
          items.push({ title: titleText, price: priceText });
          purchasedHits++;
        }
      }
      if (purchasedHits > 0) {
        debugSelectors.push({ selector: 'purchasedItems', hits: purchasedHits });
        break; // stop after first root with real purchased items
      }
    }

    if (purchasedHits === 0) {
      for (const root of rootsToUse) {
        const fallbackLinks = Array.from(root.querySelectorAll('[data-component="itemTitle"] a, a.a-link-normal[href*="/dp/"]'));
        let hits = 0;
        for (const link of fallbackLinks) {
          const text = sanitize(link.textContent);
          if (!text) continue;
          pushTitle(text);
          items.push({ title: text, price: null });
          hits++;
        }
        if (hits > 0) {
          debugSelectors.push({ selector: 'fallback-itemTitle-links', hits });
          break;
        }
      }
    }

    const firstRoot = rootsToUse[0];
    const snippet = firstRoot ? sanitize(firstRoot.textContent ?? "") : null;

    const dedupedItems: RawItem[] = [];
    const seenItems = new Set<string>();
    for (const item of items) {
      const title = sanitize(item.title);
      if (!title) continue;
      if (seenItems.has(title)) continue;
      seenItems.add(title);
      dedupedItems.push({ title, price: sanitize(item.price) });
    }

    return {
      titles,
      items: dedupedItems,
      debugSelectors,
      foundRoot: (firstRoot instanceof HTMLElement && firstRoot.id) ? `#${firstRoot.id}` : (firstRoot?.tagName ?? "unknown"),
      rootSnippet: snippet ? snippet.slice(0, 500) : null
    };
  });

  console.log(`   Selektor-Treffer (${orderId} @ ${foundRoot}): ${debugSelectors.map(({ selector, hits }) => `${selector}:${hits}`).join(", ")}`);
  if (titles.length === 0 && rootSnippet) {
    console.log(`   [Debug] Root-Ausschnitt (${orderId}): ${rootSnippet}`);
  }

  const unique = Array.from(new Set(titles));
  const normalizedItems: OrderItem[] = [];
  const seenItemTitles = new Set<string>();
  for (const item of rawItems) {
    const title = item.title ? item.title.trim() : null;
    if (!title) continue;
    if (seenItemTitles.has(title)) continue;
    seenItemTitles.add(title);
    normalizedItems.push({ title, price: item.price ?? null });
  }

  console.timeEnd(label);
  return {
    titles: unique.length ? unique : null,
    items: normalizedItems.length ? normalizedItems : null
  };
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
  const transactions = await extractTransactions(page, cliOptions);

  // Step 2: Fetch order details for selected transactions
  console.log(`[2/4] Lade Bestelldetails für ${transactions.length} Transaktionen (Modus: ${cliOptions.mode})...`);
  const seenOrderIds = new Set<string>();
  let fetched = 0;
  for (const tx of transactions) {
    if (!tx.orderId) {
      console.warn('   [Detail] Überspringe Transaktion ohne orderId:', JSON.stringify({ date: tx.date, amount: tx.amount, merchant: tx.merchant }));
      continue;
    }
    if (seenOrderIds.has(tx.orderId)) {
      console.log(`   [Detail] Überspringe ${tx.orderId} – bereits verarbeitet.`);
      continue;
    }
    console.log(`   [Detail] Lade Titel für ${tx.orderId} (${tx.date ?? "kein Datum"})...`);
    const detail = await fetchOrderTitles(page, tx.orderId, tx.orderUrl ?? null);
    const rawTitles = detail?.titles ?? null;
    const rawItems = detail?.items ?? null;

    const cleanedTitles = rawTitles ? rawTitles.filter((t) => !/Anmelden/i.test(t)) : null;
    const dedupedTitles = cleanedTitles ? Array.from(new Set(cleanedTitles)) : null;

    const cleanedItems = rawItems
      ? rawItems
          .map((item) => ({ title: item.title.trim(), price: item.price }))
          .filter((item) => !isLoginText(item.title))
      : null;

    const formattedDescription = formatOrderDescription(cleanedItems, dedupedTitles);

    const related = transactions.filter(t => t.orderId === tx.orderId);
    for (const r of related) {
      r.orderItems = cleanedItems;
      r.orderTitles = dedupedTitles;
      r.orderDescription = formattedDescription;
      scrubLoginFields(r);
      // Generate AI summary for YNAB memo
      if (formattedDescription) {
        r.aiSummary = await generateSummary(formattedDescription);
      }
    }
    seenOrderIds.add(tx.orderId);
    fetched++;
    if (!dedupedTitles && !(cleanedItems && cleanedItems.length)) {
      console.warn(`   [Detail] Keine Titel für ${tx.orderId} gefunden.`);
    } else {
      const previewSource = cleanedItems && cleanedItems.length ? cleanedItems.map(i => i.title) : (dedupedTitles ?? []);
      const preview = previewSource.slice(0, 3).join(' | ');
      console.log(`   [Detail] ${tx.orderId}: ${previewSource.length} Positionen erfasst. Vorschau: ${preview}`);
    }
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
      if (t.orderItems !== undefined) ex.orderItems = t.orderItems ?? ex.orderItems ?? null;
      if (t.aiSummary !== undefined) ex.aiSummary = t.aiSummary ?? ex.aiSummary ?? null;
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
  console.log(`[4/4] Zusammenfassung (Modus: ${cliOptions.mode}${cliOptions.mode === 'last-n' ? `, letzte ${cliOptions.lastCount}` : ''}${cliOptions.mode === 'date-range' ? `, ${cliOptions.startDate ?? '?'} bis ${cliOptions.endDate ?? '?'}` : ''})`);
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
  console.log(`Detailseiten geladen: ${fetched}`);
  console.log(`Aktuelle Gesamtanzahl: ${mergedPayload.count}`);
  console.timeEnd("total:run");

  await browser.close();
}

main().catch((e) => {
  console.error("=== AMAZON SCRAPING FEHLER ===");
  console.error("Error:", e.message || e);
  console.error("Error Type:", e.constructor?.name || 'Unknown');
  console.error("Stack:", e.stack || 'No stack trace');
  
  // Environment debugging
  console.error("=== ENVIRONMENT INFO ===");
  console.error("Playwright version:", require('playwright').version || 'Unknown');
  console.error("Node.js version:", process.version);
  console.error("Platform:", process.platform);
  console.error("HEADLESS mode:", HEADLESS);
  console.error("Options:", cliOptions);
  
  // Common error scenarios and solutions
  if (e.message?.includes('Timeout') || e.message?.includes('timeout')) {
    console.error("=== TIMEOUT ERROR ===");
    console.error("Mögliche Ursachen:");
    console.error("- Amazon blockiert den Zugriff (Captcha/Rate Limiting)");
    console.error("- Langsame Internetverbindung");
    console.error("- Login State ist abgelaufen - login.ts erneut ausführen");
    console.error("Lösungen:");
    console.error("1. login.ts ausführen um storageState zu erneuern");
    console.error("2. Weniger Transaktionen anfordern (--last 10)");
    console.error("3. HEADLESS=false setzen für visuelles Debugging");
  } else if (e.message?.includes('login') || e.message?.includes('Login') || e.message?.includes('signin')) {
    console.error("=== LOGIN ERROR ===");
    console.error("Login State ist ungültig oder abgelaufen.");
    console.error("Führe zuerst login.ts aus um storageState zu erneuern.");
  } else if (e.message?.includes('storageState') || e.message?.includes('storage')) {
    console.error("=== STORAGE STATE ERROR ===");
    console.error("Amazon storage state ist nicht verfügbar oder ungültig.");
    console.error("Führe login.ts aus um den Login-Prozess zu starten.");
  } else if (e.message?.includes('captcha') || e.message?.includes('Captcha')) {
    console.error("=== CAPTCHA ERROR ===");
    console.error("Amazon hat ein Captcha gestellt.");
    console.error("Führe login.ts aus und löse das Captcha manuell.");
  }
  
  console.error("=== DEBUG TIPS ===");
  console.error("1. Prüfe .env Datei auf fehlende Variablen");
  console.error("2. Führe login.ts aus falls Login erforderlich");
  console.error("3. Setze HEADLESS=false für visuelles Debugging");
  console.error("4. Prüfe Internetverbindung und Amazon-Erreichbarkeit");
  console.error("=== END ERROR ===");
  process.exit(1);
});
