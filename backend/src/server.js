/*
 * Express server.
 *   POST /scrape   — run Naukri scraper
 *   POST /analyze  — run Groq analysis on the scraped CSV
 *   GET  /download — stream the CSV back to the browser
 *
 * The frontend talks to this server over CORS. The Groq API key is only
 * read on the server side via dotenv — never bundled into React.
 */

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const scrapeRoute = require("./routes/scrape");
const analyzeRoute = require("./routes/analyze");

const app = express();
app.use(cors());
app.use(express.json());

const CSV_PATH = process.env.CSV_OUTPUT_PATH || path.join(__dirname, "..", "data", "jobs.csv");

app.get("/", (_req, res) => {
  res.json({
    name: "Naukri Scrapper Backend",
    endpoints: ["POST /scrape", "POST /analyze", "GET /download", "GET /status"],
  });
});

app.get("/status", (_req, res) => {
  res.json({
    csvPath: CSV_PATH,
    csvExists: fs.existsSync(CSV_PATH),
    hasGroqKey: Boolean(process.env.GROQ_API_KEY),
    groqModel: process.env.GROQ_MODEL || "llama-3.1-70b-versatile",
  });
});

app.get("/download", (req, res) => {
  if (!fs.existsSync(CSV_PATH)) {
    return res.status(404).json({ ok: false, error: "No CSV yet. Run /scrape first." });
  }
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", `attachment; filename="jobs.csv"`);
  fs.createReadStream(CSV_PATH).pipe(res);
});

app.use("/scrape", scrapeRoute);
app.use("/analyze", analyzeRoute);

const PORT = parseInt(process.env.PORT || "4000", 10);
app.listen(PORT, () => {
  console.log(`Backend listening on http://localhost:${PORT}`);
});
