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
 *   7. For each card: extract company name + AmbitionBox review link
 *   8. Visit AmbitionBox link, scrape official website from company About page
 *   9. Write rows to CSV incrementally (company, officialWebsite)
 *   10. Save AmbitionBox links to separate file for reference
 *
 * CSV output: company, officialWebsite, scrapedAt
 * Separate file: ambitionbox_links.json (company -> ambitionboxUrl)
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

// Extract official website from AmbitionBox company Overview page
// Uses a separate page to avoid losing the Naukri results page context
async function scrapeOfficialWebsiteFromAmbitionBox(browser, ambitionBoxUrl, companyName) {
  const page = await browser.newPage();
  try {
    // Convert reviews URL to overview URL
    // Reviews: https://www.ambitionbox.com/reviews/mastercard-reviews?...
    // Overview: https://www.ambitionbox.com/overview/mastercard-overview
    let overviewUrl = ambitionBoxUrl;
    if (ambitionBoxUrl.includes("/reviews/")) {
      overviewUrl = ambitionBoxUrl
        .replace("/reviews/", "/overview/")
        .replace("-reviews", "-overview");
    }
    
    console.log(`   → Visiting AmbitionBox Overview: ${overviewUrl}`);
    await page.goto(overviewUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
    await randDelay(2000, 4000);

    // Check for challenge
    const challenge = await detectChallenge(page);
    if (challenge) {
      console.warn(`   AmbitionBox challenge detected: ${challenge}`);
      return "direct domain scrape not possible";
    }

    // Scroll down to load the website section
    await page.evaluate(async () => {
      await new Promise((resolve) => {
        let total = 0;
        const id = setInterval(() => {
          window.scrollBy(0, 500);
          total += 500;
          if (total >= document.body.scrollHeight) {
            clearInterval(id);
            resolve();
          }
        }, 200);
      });
    });
    await randDelay(1000, 2000);

    // Look for the website link - specific AmbitionBox structure:
    // <div>Website</div> followed by <a testid="Website" data-testid="Website" aria-label="domain.com">
    const websiteSelectors = [
      // Direct selectors based on the HTML structure provided
      'a[testid="Website"]',
      'a[data-testid="Website"]',
      'a[aria-label]:has-text(".in"), a[aria-label]:has-text(".com"), a[aria-label]:has-text(".org"), a[aria-label]:has-text(".net")',
      // Generic: link next to "Website" text
      '//div[contains(text(), "Website")]/following-sibling::a[@href]',
      '//div[contains(text(), "Website")]/parent::div//a[@href]',
      '//*[contains(text(), "Website")]/following::a[@href][1]',
    ];

    for (const sel of websiteSelectors) {
      try {
        const link = page.locator(sel).first();
        if (await link.count()) {
          const href = await link.getAttribute("href").catch(() => "");
          const ariaLabel = await link.getAttribute("aria-label").catch(() => "");
          const text = await link.innerText().catch(() => "");
          
          // Get the actual website URL
          let websiteUrl = href || ariaLabel || text;
          
          if (websiteUrl && (websiteUrl.startsWith("http") || websiteUrl.includes("."))) {
            // Ensure it has a protocol
            if (!websiteUrl.startsWith("http")) {
              websiteUrl = `https://${websiteUrl}`;
            }
            
            // Filter out social media and known non-website links
            const excludePatterns = [
              "linkedin.com", "facebook.com", "twitter.com", "x.com",
              "instagram.com", "youtube.com", "glassdoor.com", "indeed.com",
              "ambitionbox.com", "naukri.com", "github.com", "angel.co",
              "crunchbase.com", "wikipedia.org", "play.google.com", "apps.apple.com"
            ];
            
            const isExcluded = excludePatterns.some(p => websiteUrl.includes(p));
            if (!isExcluded) {
              console.log(`   ✓ Found official website: ${websiteUrl}`);
              return websiteUrl;
            }
          }
        }
      } catch (_) {
      }
    }

    // Fallback: try to find any external link in the main content area
    try {
      const allLinks = await page.locator('a[href^="http"]').all();
      for (const link of allLinks) {
        const href = await link.getAttribute("href").catch(() => "");
        if (href && href.startsWith("http")) {
          const excludePatterns = [
            "linkedin.com", "facebook.com", "twitter.com", "x.com",
            "instagram.com", "youtube.com", "glassdoor.com", "indeed.com",
            "ambitionbox.com", "naukri.com", "github.com", "angel.co",
            "crunchbase.com", "wikipedia.org", "play.google.com", "apps.apple.com"
          ];
          const isExcluded = excludePatterns.some(p => href.includes(p));
          if (!isExcluded) {
            console.log(`   ✓ Found website (fallback): ${href}`);
            return href;
          }
        }
      }
    } catch (_) {
    }

    console.warn(`   Could not find official website on AmbitionBox for ${companyName}`);
    return "direct domain scrape not possible";
  } catch (err) {
    console.warn(`   Error scraping AmbitionBox for ${companyName}: ${err.message}`);
    return "direct domain scrape not possible";
  } finally {
    await page.close().catch(() => {});
  }
}

async function scrapeNaukri({ sampleSize = DEFAULT_SAMPLE_SIZE, csvPath } = {}) {
  if (!csvPath) csvPath = "./data/jobs.csv";
  
  // AmbitionBox links file
  const ambitionBoxFile = csvPath.replace(".csv", "_ambitionbox_links.json");
  
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  fs.writeFileSync(csvPath, "");
  
  // Load existing AmbitionBox links if file exists
  let ambitionBoxLinks = {};
  if (fs.existsSync(ambitionBoxFile)) {
    try {
      ambitionBoxLinks = JSON.parse(fs.readFileSync(ambitionBoxFile, "utf-8"));
    } catch (_) {
      ambitionBoxLinks = {};
    }
  }

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

    // Location field: click the "Select" button inside it
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

          // Find AmbitionBox review link in the card
          // Structure: div.srp-jobtuple-wrapper → div.row-2 → a.rating
          let ambitionBoxUrl = "";
          const ambitionBoxSelectors = [
            'div[class*="srp-jobtuple-wrapper"] div[class*="row-2"] a[class*="rating"]',
            'div[class*="srp-jobtuple-wrapper"] a[class*="rating"]',
            'div[class*="jobTuple"] a[class*="rating"]',
            'a[class*="rating"][href*="ambitionbox"]',
            'a[href*="ambitionbox.com"][class*="rating"]',
          ];
          
          for (const sel of ambitionBoxSelectors) {
            const link = card.locator(sel).first();
            if (await link.count()) {
              const href = await link.getAttribute("href").catch(() => "");
              if (href && href.includes("ambitionbox")) {
                ambitionBoxUrl = href.startsWith("http") ? href : `https://www.ambitionbox.com${href}`;
                break;
              }
            }
          }

          // If still not found, try broader search
          if (!ambitionBoxUrl) {
            const allLinks = card.locator('a[href*="ambitionbox.com"]');
            const linkCount = await allLinks.count();
            for (let j = 0; j < linkCount; j++) {
              const href = await allLinks.nth(j).getAttribute("href").catch(() => "");
              if (href && href.includes("ambitionbox")) {
                ambitionBoxUrl = href.startsWith("http") ? href : `https://www.ambitionbox.com${href}`;
                break;
              }
            }
          }

          if (!ambitionBoxUrl) {
            console.warn(`   No AmbitionBox link found for ${company}, skipping`);
            continue;
          }

          // Store AmbitionBox link
          ambitionBoxLinks[company] = ambitionBoxUrl;
          fs.writeFileSync(ambitionBoxFile, JSON.stringify(ambitionBoxLinks, null, 2));

          // Scrape official website from AmbitionBox
          console.log(`   → Scraping official website for ${company} from AmbitionBox…`);
          const officialWebsite = await scrapeOfficialWebsiteFromAmbitionBox(browser, ambitionBoxUrl, company);

          const row = {
            company,
            officialWebsite,
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
    console.log(`✓ AmbitionBox links saved to ${ambitionBoxFile}`);
    return { count: totalSoFar, csvPath, records: collected, ambitionBoxFile };
  } catch (err) {
    console.error(`✗ Scrape failed: ${err.message}`);
    return { count: totalSoFar, csvPath, records: collected, error: err.message, ambitionBoxFile };
  } finally {
    csvStream.end();
    await context.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

module.exports = { scrapeNaukri };