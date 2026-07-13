/*
 * Naukri scraper using Playwright (headless).
 *
 * Flow:
 *   1. Open https://www.naukri.com
 *   2. Fill role/skills = "software developer"
 *   3. Pick Experience = 0 (fresher) from the dropdown
 *   4. Leave Location empty
 *   5. Click Search
 *   6. waitForSelector on job listing cards
 *   7. Scrape each card; paginate until sampleSize reached
 *   8. Write rows to CSV incrementally (one row at a time) so a
 *      mid-scrape crash does not lose data.
 *
 * The scraper is intentionally defensive:
 *   - Randomized delays (2-5s) between human-ish actions
 *   - Detects captcha/login walls via selectors and bail out cleanly
 *   - All wrapping is in try/catch/finally; CSV stream is flushed
 *
 * DEBUGGING ADDITIONS (this version):
 *   - captureDebug() saves a full-page screenshot + full HTML to ./debug
 *     at every bail-out point, so failures are inspectable instead of
 *     being a black box.
 *   - Logs navigator.webdriver so you know if that flag is exposed.
 *   - Attempts to dismiss common cookie/consent/location modals, since
 *     those silently block form interaction and can look identical to
 *     a "challenge" from the outside.
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { format } = require("fast-csv");

const DEFAULT_SAMPLE_SIZE = parseInt(process.env.SCRAPE_SAMPLE_SIZE || "50", 10);
const DEBUG_DIR = process.env.SCRAPE_DEBUG_DIR || "./debug";
const HEADLESS = process.env.SCRAPE_HEADLESS !== "false"; // set SCRAPE_HEADLESS=false to watch it run

// Cards on search results page. Naukri renders server-side HTML for the
// initial list and hydrates with React; we anchor to the article wrapper.
// NOTE: verify these against a fresh ./debug HTML dump — Naukri renames
// classes periodically and this is the first thing to update if scraping
// silently returns 0 cards.
const JOB_CARD_SELECTOR = "article.jobTuple, .jobTuple, [data-job-id]";

// Block / challenge detection (fail gracefully, do not bypass).
const CHALLENGE_SELECTORS = [
  'iframe[src*="captcha"]',
  'iframe[src*="recaptcha"]',
  "text=Verify you are human",
  "text=Access Denied",
  "text=Please Login",
  "text=Sign in to continue",
];

// Cookie / consent / location modals are NOT challenges — they're just UI
// sitting on top of the page. Dismiss these before treating anything as
// a real block.
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

// Random delay helper for polite pacing.
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
      // ignore selector parse errors
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
      // ignore
    }
  }
}

// Saves a full-page screenshot + full HTML snapshot so a failure can be
// inspected after the fact instead of guessed at. Call this at every
// bail-out / throw point.
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

async function scrapeNaukri({ sampleSize = DEFAULT_SAMPLE_SIZE, csvPath } = {}) {
  if (!csvPath) csvPath = "./data/jobs.csv";
  // Ensure directory exists.
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  // Truncate previous output so each run starts clean.
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

    // Diagnostic: is the automation flag exposed? Many bot-detection
    // systems check this first. This doesn't change behavior — it just
    // tells you whether it's a plausible factor.
    const isWebdriver = await page.evaluate(() => navigator.webdriver).catch(() => null);
    console.log(`→ navigator.webdriver = ${isWebdriver}`);

    // Consent/location modals commonly sit on top of the page and block
    // every subsequent click/type — dismiss before doing anything else.
    await dismissConsentModals(page);

    // Naukri serves many homepage variants. Wait for any common search-related
    // element to appear, or proceed after a generic delay if nothing matches.
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
    // Try multiple common role input selectors
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
    await roleInput.type("software developer", { delay: 80 });

    // Experience dropdown: click to open, pick "0 years" / "Fresher"
    const expDDSelectors = ["#expDD", ".expDD", "[id*='expDD']", "div[class*='exp']", "select[name*='exp' i]"];
    let expDD = null;
    for (const sel of expDDSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count()) { expDD = loc; break; }
    }
    if (expDD) {
      await expDD.click();
      await randDelay();
      const fresherSelectors = [
        '//li[normalize-space()="0 years"]',
        '//li[normalize-space()="Fresher"]',
        '//li[contains(., "0 year")]',
        '//li[contains(., "Fresher")]',
        'li:has-text("0 years")',
        'li:has-text("Fresher")',
      ];
      for (const sel of fresherSelectors) {
        const opt = page.locator(sel).first();
        if (await opt.count()) {
          await opt.click();
          break;
        }
      }
    } else {
      // Fallback: try typing into an experience text field
      const expText = page.locator('input[placeholder*="Experience" i], input[name*="exp" i]').first();
      if (await expText.count()) {
        await expText.click();
        await expText.fill("0");
      }
    }

    await randDelay();

    // Click the Search button
    const searchBtnSelectors = [
      "button[type='submit']",
      "input[type='submit']",
      "a.search-btn",
      "button:has-text('Search')",
      "button:has-text('SEARCH')",
      "[class*='searchBtn']",
      "[class*='search-btn']",
    ];
    let searchBtn = null;
    for (const sel of searchBtnSelectors) {
      const loc = page.locator(sel).first();
      if (await loc.count()) { searchBtn = loc; break; }
    }
    if (!searchBtn) {
      await captureDebug(page, "no-search-button");
      throw new Error(`Could not locate Search button. See ${DEBUG_DIR} for a screenshot/HTML dump.`);
    }
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
      searchBtn.click(),
    ]);

    console.log("→ Waiting for results page to render job cards…");
    await dismissConsentModals(page);

    // Results page cards — be broad since class names change
    const resultsAppeared = await page.waitForSelector(
      'article[class*="jobTuple"], div[class*="jobTuple"], div[data-job-id], li[class*="jobTuple"], div[class*="srp-jobtuple"]',
      { timeout: 60000 }
    ).then(() => true).catch(() => false);

    if (!resultsAppeared) {
      await captureDebug(page, "no-results-cards");
      const challengeOnResults = await detectChallenge(page);
      if (challengeOnResults) {
        throw new Error(
          `Challenge appeared on results page (${challengeOnResults}). Aborting. See ${DEBUG_DIR} for a screenshot/HTML dump.`
        );
      }
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

      // Broader card selector — Naukri changes class names often
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
          // Use broader extraction — try multiple selectors per field
          const title =
            (await card.locator('a[class*="title"], .title, [class*="title"] a, h2, h3').first().innerText().catch(() => ""))?.trim() ||
            (await card.locator("a").first().getAttribute("title").catch(() => "")) ||
            "";
          const company =
            (await card.locator('a[class*="company"], .companyInfo a, a.subTitle, [class*="comp-name"], [class*="company"]').first().innerText().catch(() => ""))?.trim() ||
            "";
          const location =
            (await card.locator('[class*="location"], .locationsContainer, .location, .loc, [class*="loc"]').first().innerText().catch(() => ""))?.trim() ||
            "";
          const experience =
            (await card.locator('[class*="experience"], .experienceContainer, .exp, .exp-wdgt, [class*="exp"]').first().innerText().catch(() => ""))?.trim() ||
            "";
          const salary =
            (await card.locator('[class*="salary"], .salaryContainer, .sal, .salary, [class*="sal"]').first().innerText().catch(() => ""))?.trim() ||
            "";
          const skillsText =
            (await card.locator('[class*="skill"], [class*="tag"], .tagsContainer, .skills, .keySkills, ul.tags li').first().innerText().catch(() => ""))?.trim() ||
            "";
          const description =
            (await card.locator('[class*="description"], .job-description, .jobDesc, .job-desc, [class*="desc"]').first().innerText().catch(() => ""))?.trim() ||
            "";
          const postedDate =
            (await card.locator('[class*="posted"], [class*="footer"], .jobTupleFooter, .postedDate, .footerText').first().innerText().catch(() => ""))?.trim() ||
            "";
          const url =
            (await card.locator('a[class*="title"], a').first().getAttribute("href").catch(() => "")) || "";

          const row = {
            title,
            company,
            location,
            experience,
            salary,
            skills: skillsText.replace(/\n/g, " | "),
            description: description.replace(/\n/g, " "),
            postedDate,
            url,
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

      // Pagination: try next-page button. Naukri usually uses a "Next" anchor.
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
      await page.waitForSelector("article.jobTuple, .jobTuple, [data-job-id]", { timeout: 60000 }).catch(() => {});
      pageNum += 1;
      await randDelay();
    }

    console.log(`Done. ${totalSoFar} job records written to ${csvPath}`);
    return { count: totalSoFar, csvPath, records: collected };
  } catch (err) {
    console.error(`Scrape failed: ${err.message}`);
    // We still return whatever we collected — partial data is better than nothing.
    return { count: totalSoFar, csvPath, records: collected, error: err.message };
  } finally {
    csvStream.end();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeNaukri };