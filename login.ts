import { chromium, devices } from "playwright";

// Constants for configuration
const BROWSER_CONFIG = {
  headless: false,
  slowMo: 50,
};

const CONTEXT_CONFIG = {
  ...devices["Desktop Chrome"],
  locale: "de-DE",
  timezoneId: "Europe/Berlin",
};

const AMAZON_LOGIN_URL = "https://www.amazon.de/ap/signin?openid.pape.max_auth_age=0&openid.return_to=https%3A%2F%2Fwww.amazon.de%2F%3Flanguage%3Dde_DE%26ref_%3Dnav_signin&openid.identity=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.assoc_handle=deflex&openid.mode=checkid_setup&openid.claimed_id=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0%2Fidentifier_select&openid.ns=http%3A%2F%2Fspecs.openid.net%2Fauth%2F2.0";

const AMAZON_ORDERS_URL = "https://www.amazon.de/gp/css/order-history?ref_=ya_d_c_yo";

const ORDERS_SELECTOR = 'h1:has-text("Meine Bestellungen"), h1:has-text("Your Orders")';

const STORAGE_STATE_PATH = "amazon.storageState.json";

const LOGIN_TIMEOUT = 120_000;

/**
 * Main function to perform Amazon login and save storage state
 */
async function main(): Promise<void> {
  let browser;
  try {
    // Launch browser
    browser = await chromium.launch(BROWSER_CONFIG);

    // Create context with German locale
    const context = await browser.newContext(CONTEXT_CONFIG);
    const page = await context.newPage();

    // Navigate to Amazon login page
    await page.goto(AMAZON_LOGIN_URL, { waitUntil: "domcontentloaded" });

    // Manual login: User enters email/password, solves 2FA/CAPTCHA
    // Wait until logged in by checking orders page
    await page.goto(AMAZON_ORDERS_URL, { waitUntil: "domcontentloaded" });

    // Verify login by waiting for orders page to load
    await page.waitForSelector(ORDERS_SELECTOR, { timeout: LOGIN_TIMEOUT });

    // Save login state
    await context.storageState({ path: STORAGE_STATE_PATH });
    console.log(`✅ Login state saved: ${STORAGE_STATE_PATH}`);

    await browser.close();
  } catch (error) {
    console.error("Error during login process:", error);
    throw error;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

// Run the main function
main().catch((error) => {
  console.error("Script failed:", error);
  process.exit(1);
});