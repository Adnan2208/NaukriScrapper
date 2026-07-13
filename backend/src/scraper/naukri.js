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

    // Make sure homepage chrome loaded before touching inputs.
    await page.waitForSelector("input#qpCloser, input.sugInp, form#searchForm", { timeout: 30000 });

    const challenge = await detectChallenge(page);
    if (challenge) {
      throw new Error(
        `Naukri is showing a challenge (${challenge}). Aborting — we do not bypass CAPTCHAs or login walls.`
      );
    }

    console.log("→ Filling search form (role = software developer, exp = 0, location = empty)…");
    // The role/skills/designation input on Naukri (the first placeholder.
    const roleInput = page.locator('input[placeholder*="Skills"], input[placeholder*="Designations"], input.sugInp').first();
    await roleInput.click();
    await roleInput.fill("");
    await roleInput.type("software developer", { delay: 80 });

    // Experience dropdown: click to open, pick "0 years" / "Fresher".
    // Naukri's exp dropdown uses a div with id expDDP and options with class "expOpt".
    const expDD = page.locator("#expDD, .expDD, [id*='expDD']").first();
    if (await expDD.count()) {
      await expDD.click();
      await randDelay();
      await page.waitForSelector('//li[normalize-space()="0 years"] | //li[normalize-space()="Fresher"]', { timeout: 5000 }).catch(() => {});
      const fresher = page.locator('//li[normalize-space()="0 years"] | //li[normalize-space()="Fresher"]').first();
      if (await fresher.count()) {
        await fresher.click();
      }
      // If the literal list-item wasn't found, fall back to typing into the
      // experience field directly (some homepage variants expose a textbox).
      if (!(await fresher.count())) {
        const expText = page.locator('input[placeholder*="Experience" i]').first();
        if (await expText.count()) {
          await expText.click();
          await expText.fill("0");
        }
      }
    }

    await randDelay();

    // Click the Search button.
    const searchBtn = page.locator("button[type='submit'], input[type='submit'], a.search-btn").first();
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {}),
      searchBtn.click(),
    ]);

    console.log("→ Waiting for results page to render job cards…");
    await page.waitForSelector("article.jobTuple, .jobTuple, [data-job-id]", { timeout: 60000 });
    await randDelay();

    while (totalSoFar < sampleSize) {
      console.log(`→ Page ${pageNum}: scrolling to load all cards…`);
      // Slow scroll to give lazy content a chance to hydrate.
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

      const cards = page.locator("article.jobTuple, .jobTuple, [data-job-id]");
      const cardCount = await cards.count();
      console.log(`   Page ${pageNum}: ${cardCount} cards present.`);
      if (cardCount === 0) {
        // Possible captcha / login wall mid-flow.
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
          const title =
            (await card.locator("a.title, .title").first().innerText().catch(() => ""))?.trim() ||
            (await card.locator("a").first().getAttribute("title").catch(() => "")) ||
            "";
          const company =
            (await card.locator(".companyInfo a, a.subTitle, .comp-name").first().innerText().catch(() => ""))?.trim() ||
            "";
          const location =
            (await card.locator(".locationsContainer, .location, .loc").first().innerText().catch(() => ""))?.trim() ||
            "";
          const experience =
            (await card.locator(".experienceContainer, .exp, .exp-wdgt").first().innerText().catch(() => ""))?.trim() ||
            "";
          const salary =
            (await card.locator(".salaryContainer, .sal, .salary").first().innerText().catch(() => ""))?.trim() ||
            "";
          const skillsText =
            (await card.locator(".tagsContainer, .skills, .keySkills, ul.tags li").first().innerText().catch(() => ""))?.trim() ||
            "";
          const description =
            (await card.locator(".job-description, .jobDesc, .job-desc").first().innerText().catch(() => ""))?.trim() ||
            "";
          const postedDate =
            (await card.locator(".jobTupleFooter, .postedDate, .footerText").first().innerText().catch(() => ""))?.trim() ||
            "";
          const url =
            (await card.locator("a.title, a").first().getAttribute("href").catch(() => "")) || "";

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

          // Write incrementally. fast-csv flushes per row.
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
