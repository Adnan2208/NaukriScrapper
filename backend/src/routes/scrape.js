const express = require("express");
const path = require("path");
const fs = require("fs");
const { scrapeNaukri } = require("../scraper/naukri");

const router = express.Router();

// POST /scrape — kicks off a fresh scrape run.
// Optional query: ?sampleSize=50 (default 50, capped by env SCRAPE_SAMPLE_SIZE).
router.post("/", async (req, res) => {
  const envCap = parseInt(process.env.SCRAPE_SAMPLE_SIZE || "50", 10);
  const requested = parseInt(req.query.sampleSize || req.body?.sampleSize || envCap, 10);
  // Clamp to a sane upper bound. College project — keep it polite.
  const sampleSize = Math.min(Math.max(1, requested), 200);

  const csvPath = process.env.CSV_OUTPUT_PATH || path.join(__dirname, "..", "..", "data", "jobs.csv");
  console.log(`[scrape] start (sampleSize=${sampleSize}, csvPath=${csvPath})`);

  const result = await scrapeNaukri({ sampleSize, csvPath });
  console.log(`[scrape] done (count=${result.count}, error=${result.error || "none"})`);

  res.json({
    ok: !result.error,
    count: result.count,
    csvPath: result.csvPath,
    error: result.error || null,
    csvExists: fs.existsSync(result.csvPath),
  });
});

module.exports = router;
