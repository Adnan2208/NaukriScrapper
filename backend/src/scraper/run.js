// CLI entry point: `npm run scrape`
// Useful for testing the scraper without spinning up the API server.

require("dotenv").config();
const { scrapeNaukri } = require("./naukri");

(async () => {
  const sampleSize = parseInt(process.argv[2] || process.env.SCRAPE_SAMPLE_SIZE || "50", 10);
  console.log(`Running Naukri scraper (sampleSize=${sampleSize})…`);
  const result = await scrapeNaukri({ sampleSize });
  console.log("Result:", { count: result.count, records: result.records.length, error: result.error || null });
  process.exit(result.error ? 1 : 0);
})();
