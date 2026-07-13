/*
 * Naukri scraper using Playwright (headless).
 *
 * Flow:
 *   1. Open https://www.naukri.com
 *   2. Fill role/skills = "software developer"
 *   3. Pick Experience = 0 (fresher) via dropdown (press Enter)
 *   4. Handle location field (click Select button if present)
 *   5. Submit search via Enter key
 *   6. waitForSelector on job listing cards
 *   7. Scrape each card; paginate until sampleSize reached
 *   8. Write rows to CSV incrementally (one row at a time)
 *
 * Scrapes ONLY:
 *   - company: company name from the job card
 *   - website: official company website
 *       1. Check pre-made popular company map
 *       2. If not found and Clearbit API key is set, query Clearbit autocomplete
 *       3. Fallback: "direct domain scrape not possible"
 *
 * The scraper is intentionally defensive:
 *   - Randomized delays (2-5s) between human-ish actions
 *   - Detects captcha/login walls via selectors and bails out cleanly
 *   - All wrapping in try/catch/finally; CSV stream is flushed
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { format } = require("fast-csv");

const DEFAULT_SAMPLE_SIZE = parseInt(process.env.SCRAPE_SAMPLE_SIZE || "50", 10);
const DEBUG_DIR = process.env.SCRAPE_DEBUG_DIR || "./debug";
const HEADLESS = process.env.SCRAPE_HEADLESS === "false" ? false : true;
const CLEARBIT_API_KEY = process.env.CLEARBIT_API_KEY;

// Pre-made map of popular companies -> official websites
const POPULAR_COMPANY_WEBSITES = require("./popularCompanies.json");

const CHALLENGE_SELECTORS = [
  'iframe[src*="captcha"]',
  'iframe[src*="recaptcha"]',
  "text=Verify you are human",
  "text=Access Denied",
  "text=Please Login",
  "text=Sign in to continue",
];

const CONSENT_DISMISS_SELECTORS = [
  'button:has-text("Accept")',
  'button:has-text("Accept All")',
  'button:has-text("Allow")',
  'button:has-text("Got it")',
  '[class*="cookie"] button',
  '[class*="consent"] button',
  '[id*="cookie"] button',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function randDelay(min = 2000, max = 5000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(ms);
}

async function detectChallenge(page) {
  for (const sel of CHALLENGE_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el) return sel;
    } catch (_) {
    }
  }
  return null;
}

async function dismissConsentModals(page) {
  for (const sel of CONSENT_DISMISS_SELECTORS) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.count()) {
        await btn.click({ timeout: 3000 }).catch(() => {});
        console.log(`   Dismissed modal via selector: ${sel}`);
        await sleep(500);
      }
    } catch (_) {
    }
  }
}

async function captureDebug(page, tag) {
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const shotPath = path.join(DEBUG_DIR, `${stamp}_${tag}.png`);
    const htmlPath = path.join(DEBUG_DIR, `${stamp}_${tag}.html`);
    await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => "");
    fs.writeFileSync(htmlPath, html);
    console.log(`   [debug] saved ${shotPath}`);
    console.log(`   [debug] saved ${htmlPath}`);
  } catch (e) {
    console.warn(`   [debug] capture failed: ${e.message}`);
  }
}

// Resolve company website:
// 1. Check pre-made popular company map
// 2. If not found and Clearbit API key is set, query Clearbit autocomplete
// 3. Fallback: return "direct domain scrape not possible"
async function resolveCompanyWebsite(companyName) {
  if (!companyName || !companyName.trim()) {
    return "direct domain scrape not possible";
  }

  const cleanKey = companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .trim();

  if (!cleanKey) {
    return "direct domain scrape not possible";
  }

  // 1. Popular company map
  if (POPULAR_COMPANY_WEBSITES[cleanKey]) {
    return POPULAR_COMPANY_WEBSITES[cleanKey];
  }

  // 2. Clearbit Autocomplete API (no API key required)
  try {
    const response = await fetch(
      `https://autocomplete.clearbit.com/v1/companies/suggest?query=${encodeURIComponent(companyName)}`
    );

    if (response.ok) {
      const data = await response.json();

      if (Array.isArray(data) && data.length > 0 && data[0].domain) {
        return `https://${data[0].domain}`;
      }
    }
  } catch (_) {
    // Ignore errors and fall through
  }

  // 3. Fallback
  return "direct domain scrape not possible";
}

async function scrapeNaukri({ sampleSize = DEFAULT_SAMPLE_SIZE, csvPath } = {}) {
  if (!csvPath) csvPath = "./data/jobs.csv";
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  fs.writeFileSync(csvPath, "");

  const csvStream = format({ headers: true });
  csvStream.pipe(fs.createWriteStream(csvPath, { flags: "a" }));

  const collected = [];
  let pageNum = 1;
  let totalSoFar = 0;

  const browser = await chromium.launch({ headless: HEADLESS });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  try {
    console.log("→ Launching browser, navigating to Naukri…");
    await page.goto("https://www.naukri.com", { waitUntil: "domcontentloaded", timeout: 60000 });

    const isWebdriver = await page.evaluate(() => navigator.webdriver).catch(() => null);
    console.log(`→ navigator.webdriver = ${isWebdriver}`);

    await dismissConsentModals(page);

    console.log("→ Waiting for search UI to appear…");
    await Promise.race([
      page.waitForSelector('input[placeholder*="Skills" i], input[placeholder*="Designations" i], input.sugInp, input[placeholder*="Role" i], input[placeholder*="job" i], form#searchForm, div[class*="searchForm"], div[class*="homePage"]', { timeout: 30000 }).catch(() => {}),
      sleep(8000),
    ]);

    const challenge = await detectChallenge(page);
    if (challenge) {
      await captureDebug(page, "challenge-detected");
      throw new Error(
        `Naukri is showing a challenge (${challenge}). Aborting — we do not bypass CAPTCHAs or login walls. See ${DEBUG_DIR} for a screenshot/HTML dump.`
      );
    }

    console.log("→ Filling search form (role = software developer, exp = 0, location = empty)…");
    const roleSelectors = [
      'input[placeholder*="Skills" i]',
      'input[placeholder*="Designations" i]',
      'input[placeholder*="Role" i]',
      'input[placeholder*="job" i]',
      'input.sugInp',
      'input[placeholder*="Keywords" i]',
      '#qpCloser',
      'input[id*="skill"]',
    ];
    let roleInput = null;
    for (const sel of roleSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count()) { roleInput = loc; break; }
    }
    if (!roleInput) {
      await captureDebug(page, "no-role-input");
      throw new Error(`Could not locate role/skills input on Naukri homepage. See ${DEBUG_DIR} for a screenshot/HTML dump.`);
    }
    await roleInput.click();
    await roleInput.fill("");
    await roleInput.type("Software Developer", { delay: 80 });

    // Experience field: click it, then press Enter to select "Fresher" (first option)
    console.log("→ Setting experience to Fresher via dropdown…");
    const expInputSelectors = [
      'input[placeholder*="Experience" i]',
      'input[name*="exp" i]',
      'input[id*="exp" i]',
      'input[placeholder*="Select Experience" i]',
      'input[class*="exp"]',
      'input[aria-label*="Experience" i]',
      'input[placeholder*="Year" i]',
    ];
    let expInput = null;
    for (const sel of expInputSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count()) { expInput = loc; break; }
    }
    if (!expInput) {
      const fallback = page.locator('//input[preceding::text()[contains(., "Experience")]][1]').first();
      if (await fallback.count()) expInput = fallback;
    }
    if (!expInput) {
      await captureDebug(page, "no-exp-input");
      throw new Error(`Could not locate Experience input field. See ${DEBUG_DIR} for a screenshot/HTML dump.`);
    }
    await expInput.click();
    await randDelay(500, 1000);
    await page.keyboard.press("Enter");
    await randDelay();

    // Location field: click the "Select" button inside it (as user described)
    console.log("→ Handling location field…");
    const locationSelectBtnSelectors = [
      'input[placeholder*="Location" i] + button',
      'input[placeholder*="Location" i] ~ button',
      'button:has-text("Select"):near(input[placeholder*="Location" i])',
      'div[class*="location"] button:has-text("Select")',
      'button[class*="location"]:has-text("Select")',
      '//input[contains(@placeholder, "Location")]/following-sibling::button',
      '//label[contains(., "Location")]/following-sibling::div//button[contains(., "Select")]',
    ];
    for (const sel of locationSelectBtnSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count()) {
        await loc.click().catch(() => {});
        await randDelay(500, 1000);
        break;
      }
    }
    // If no select button found, just click the location input to dismiss any dropdown
    const locationInput = page.locator('input[placeholder*="Location" i]').first();
    if (await locationInput.count()) {
      await locationInput.click().catch(() => {});
      await randDelay(500, 1000);
    }

    await randDelay();

    // Submit search via Enter key
    console.log("→ Submitting search via Enter key…");
    await page.keyboard.press("Enter");

    console.log("→ Waiting for results page to render job cards…");
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await dismissConsentModals(page);

    const challengeOnResults = await detectChallenge(page);
    if (challengeOnResults) {
      await captureDebug(page, "challenge-on-results");
      throw new Error(
        `Challenge appeared on results page (${challengeOnResults}). Aborting. See ${DEBUG_DIR} for a screenshot/HTML dump.`
      );
    }

    const resultsAppeared = await page.waitForSelector(
      'article[class*="jobTuple"], div[class*="jobTuple"], div[data-job-id], li[class*="jobTuple"], div[class*="srp-jobtuple"], div[class*="job-card"], div[class*="tuple"], div[class*="listing"]',
      { timeout: 60000 }
    ).then(() => true).catch(() => false);

    if (!resultsAppeared) {
      await captureDebug(page, "no-results-cards");
      throw new Error(`No job cards appeared on results page within timeout. See ${DEBUG_DIR} for a screenshot/HTML dump — class names may have changed.`);
    }
    await randDelay();

    while (totalSoFar < sampleSize) {
      console.log(`→ Page ${pageNum}: scrolling to load all cards…`);
      await page.evaluate(async () => {
        await new Promise((resolve) => {
          let total = 0;
          const id = setInterval(() => {
            window.scrollBy(0, 400);
            total += 400;
            if (total >= document.body.scrollHeight) {
              clearInterval(id);
              resolve();
            }
          }, 200);
        });
      });

      const cardSelectors = [
        'article[class*="jobTuple"]',
        'div[class*="jobTuple"]',
        'div[data-job-id]',
        'li[class*="jobTuple"]',
        'div[class*="srp-jobtuple"]',
        'div[class*="job-card"]',
        'div[class*="tuple"]',
      ];
      let cards = null;
      for (const sel of cardSelectors) {
        const loc = page.locator(sel);
        if (await loc.count()) { cards = loc; break; }
      }
      if (!cards) cards = page.locator("article, div[data-job-id]");
      const cardCount = await cards.count();
      console.log(`   Page ${pageNum}: ${cardCount} cards present.`);
      if (cardCount === 0) {
        await captureDebug(page, `page${pageNum}-zero-cards`);
        const challengeMidway = await detectChallenge(page);
        if (challengeMidway) {
          throw new Error(`Challenge appeared on results page (${challengeMidway}). Aborting. See ${DEBUG_DIR} for a screenshot/HTML dump.`);
        }
        console.log("   No cards found — stopping pagination.");
        break;
      }

      for (let i = 0; i < cardCount && totalSoFar < sampleSize; i++) {
        const card = cards.nth(i);
        try {
          // Extract company name
          const company =
            (await card.locator('a[class*="company"], .companyInfo a, a.subTitle, [class*="comp-name"], [class*="company"]').first().innerText().catch(() => ""))?.trim() ||
            "";

          if (!company) {
            console.warn(`   Skipped card ${i} on page ${pageNum}: no company name found`);
            continue;
          }

          // Resolve website
          const website = await resolveCompanyWebsite(company);

          const row = {
            company,
            website,
            scrapedAt: new Date().toISOString(),
          };

          csvStream.write(row);
          collected.push(row);
          totalSoFar += 1;
        } catch (err) {
          console.warn(`   Skipped card ${i} on page ${pageNum}: ${err.message}`);
        }
      }

      console.log(`   Page ${pageNum}: scraped=${cardCount}, total=${totalSoFar}/${sampleSize}`);
      if (totalSoFar >= sampleSize) break;

      // Pagination
      const nextBtn = page.locator("a[aria-label='Next Page'], a.next, .pagination a:last-child").first();
      if (!(await nextBtn.count())) {
        console.log("   No next-page button — stopping.");
        break;
      }
      const disabled = await nextBtn.getAttribute("disabled").catch(() => null);
      if (disabled !== null) {
        console.log("   Next button disabled — stopping.");
        break;
      }
      await randDelay(2500, 4000);
      await nextBtn.click().catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await page.waitForSelector(
        'article[class*="jobTuple"], div[class*="jobTuple"], div[data-job-id], li[class*="jobTuple"], div[class*="srp-jobtuple"], div[class*="job-card"], div[class*="tuple"], div[class*="listing"]',
        { timeout: 60000 }
      ).catch(() => {});
      pageNum += 1;
      await randDelay();
    }

    console.log(`✓ Done. ${totalSoFar} company records written to ${csvPath}`);
    return { count: totalSoFar, csvPath, records: collected };
  } catch (err) {
    console.error(`✗ Scrape failed: ${err.message}`);
    return { count: totalSoFar, csvPath, records: collected, error: err.message };
  } finally {
    csvStream.end();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeNaukri };