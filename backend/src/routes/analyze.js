const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { parse } = require("fast-csv");

const router = express.Router();

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

async function loadCsvAggregated(csvPath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(csvPath)) {
      return reject(new Error(`No CSV found at ${csvPath} — run /scrape first.`));
    }
    const rows = [];
    fs.createReadStream(csvPath)
      .pipe(parse({ headers: true, trim: true }))
      .on("data", (row) => rows.push(row))
      .on("end", () => resolve(rows))
      .on("error", reject);
  });
}

function aggregateForPrompt(rows) {
  const companyCounts = {};
  const websiteSamples = [];

  for (const r of rows) {
    const company = (r.company || "").trim();
    if (company) {
      companyCounts[company] = (companyCounts[company] || 0) + 1;
    }
    const website = (r.website || "").trim();
    if (website) {
      websiteSamples.push({ company, website });
    }
  }

  const topN = (obj, n = 20) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} (${v})`);

  return {
    rowCount: rows.length,
    uniqueCompanies: Object.keys(companyCounts).length,
    topCompanies: topN(companyCounts, 20),
    websiteSamples: websiteSamples.slice(0, 20),
  };
}

function buildPrompt(agg) {
  return `You are an analyst reviewing a freshly-scraped sample of Naukri job listings
for software developer / fresher roles in India.

Below is an aggregated view of the dataset (do NOT echo raw rows, just answer from this).

=== Aggregated dataset ===
Total job listings: ${agg.rowCount}
Unique companies hiring: ${agg.uniqueCompanies}
Top companies (company:count): ${JSON.stringify(agg.topCompanies)}
Website samples (company:website): ${JSON.stringify(agg.websiteSamples)}
=== End dataset ===

Produce a JSON object (and ONLY JSON, no markdown, no commentary) with these keys:
{
  "topHiringCompanies": string[],          // top 10 company names, most frequent first
  "companyWebsiteExamples": string[],      // 5-10 example "Company: website" pairs
  "marketSummary": string                  // 2-3 sentence summary of the fresher SD hiring landscape based on this data
}

Rules:
- Output strictly valid JSON.
- Don't fabricate; if a field has no signal, return empty array / short note.
- Keep strings concise and useful for a college project demo.`;
}

function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  return text.trim();
}

function safeParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first !== -1 && last !== -1 && last > first) {
      try {
        return { ok: true, value: JSON.parse(text.slice(first, last + 1)) };
      } catch (_) {
        return { ok: false, error: err.message };
      }
    }
    return { ok: false, error: err.message };
  }
}

router.post("/", async (req, res) => {
  const csvPath = process.env.CSV_OUTPUT_PATH || path.join(__dirname, "..", "..", "data", "jobs.csv");
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

  if (!apiKey) {
    return res.status(500).json({ ok: false, error: "GROQ_API_KEY is missing in server .env" });
  }

  let rows;
  try {
    rows = await loadCsvAggregated(csvPath);
  } catch (err) {
    return res.status(400).json({ ok: false, error: err.message });
  }
  if (!rows.length) {
    return res.status(400).json({ ok: false, error: "CSV is empty. Run /scrape first." });
  }

  const agg = aggregateForPrompt(rows);
  const prompt = buildPrompt(agg);

  try {
    const groqRes = await axios.post(
      GROQ_URL,
      {
        model,
        messages: [
          { role: "system", content: "You only respond with strict JSON. No prose, no markdown fences." },
          { role: "user", content: prompt },
        ],
        temperature: 0.2,
        response_format: { type: "json_object" },
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    const text = groqRes.data?.choices?.[0]?.message?.content || "";
    const stripped = extractJson(text);
    const parsed = safeParseJson(stripped);
    if (!parsed.ok) {
      return res.status(502).json({
        ok: false,
        error: `Could not parse model output as JSON: ${parsed.error}`,
        raw: text,
      });
    }
    return res.json({
      ok: true,
      rowCount: rows.length,
      insights: parsed.value,
      rawModelOutput: text,
    });
  } catch (err) {
    const detail = err.response?.data || err.message;
    return res.status(502).json({ ok: false, error: "Groq call failed", detail });
  }
});

module.exports = router;