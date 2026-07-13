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
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const { format } = require("fast-csv");

const DEFAULT_SAMPLE_SIZE = parseInt(process.env.SCRAPE_SAMPLE_SIZE || "50", 10);

// Cards on search results page. Naukri renders server-side HTML for the
// initial list and hydrates with React; we anchor to the article wrapper.
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

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();

  try {
    console.log("→ Launching headless browser, navigating to Naukri…");
    await page.goto("https://www.naukri.com", { waitUntil: "domcontentloaded", timeout: 60000 });

    // Naukri serves many homepage variants. Wait for any common search-related
    // element to appear, or proceed after a generic delay if nothing matches.
    console.log("→ Waiting for search UI to appear…");
    await Promise.race([
      page.waitForSelector('input[placeholder*="Skills" i], input[placeholder*="Designations" i], input.sugInp, input[placeholder*="Role" i], input[placeholder*="job" i], form#searchForm, div[class*="searchForm"], div[class*="homePage"]', { timeout: 30000 }).catch(() => {}),
      sleep(8000),
    ]);

    const challenge = await detectChallenge(page);
    if (challenge) {
      throw new Error(
        `Naukri is showing a challenge (${challenge}). Aborting — we do not bypass CAPTCHAs or login walls.`
      );
    }

    // Dump page HTML snippet for debugging if needed
    // console.log(await page.content().then(c => c.slice(0, 3000)));

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
    if (!roleInput) throw new Error("Could not locate role/skills input on Naukri homepage");
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
    if (!searchBtn) throw new Error("Could not locate Search button");
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
      searchBtn.click(),
    ]);

    console.log("→ Waiting for results page to render job cards…");
    // Results page cards — be broad since class names change
    await page.waitForSelector(
      'article[class*="jobTuple"], div[class*="jobTuple"], div[data-job-id], li[class*="jobTuple"], div[class*="srp-jobtuple"]',
      { timeout: 60000 }
    );
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
        const challenge = await detectChallenge(page);
        if (challenge) {
          throw new Error(`Challenge appeared on results page (${challenge}). Aborting.`);
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

    console.log(`✓ Done. ${totalSoFar} job records written to ${csvPath}`);
    return { count: totalSoFar, csvPath, records: collected };
  } catch (err) {
    console.error(`✗ Scrape failed: ${err.message}`);
    // We still return whatever we collected — partial data is better than nothing.
    return { count: totalSoFar, csvPath, records: collected, error: err.message };
  } finally {
    csvStream.end();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeNaukri };
