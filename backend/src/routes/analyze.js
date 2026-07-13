const express = require("express");
const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { parse } = require("fast-csv");

const router = express.Router();

const GROQ_URL = "https://api.groq.com/openai/v1/chat/completions";

// Read the CSV and aggregate it enough to fit comfortably in a Groq context.
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

// Collapse N rows down to a compact aggregate. Avoids sending the full CSV
// verbatim — saves tokens and keeps the prompt under control.
function aggregateForPrompt(rows) {
  const skillCounts = {};
  const locationCounts = {};
  const experienceCounts = {};
  const salarySamples = [];

  for (const r of rows) {
    // Skills: usually already |-separated from the scraper.
    const skillText = (r.skills || "").replace(/\|/g, ",");
    skillText.split(/[,;]/).forEach((s) => {
      const k = s.trim().toLowerCase();
      if (k && k.length > 1) skillCounts[k] = (skillCounts[k] || 0) + 1;
    });

    const locs = (r.location || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    locs.forEach((l) => {
      locationCounts[l] = (locationCounts[l] || 0) + 1;
    });

    const exp = (r.experience || "").trim();
    if (exp) experienceCounts[exp] = (experienceCounts[exp] || 0) + 1;

    if (r.salary && r.salary.trim()) {
      salarySamples.push(r.salary.trim());
    }
  }

  const topN = (obj, n = 15) =>
    Object.entries(obj)
      .sort((a, b) => b[1] - a[1])
      .slice(0, n)
      .map(([k, v]) => `${k} (${v})`);

  return {
    rowCount: rows.length,
    topSkills: topN(skillCounts, 20),
    topLocations: topN(locationCounts, 15),
    experienceBuckets: topN(experienceCounts, 10),
    salarySamples: salarySamples.slice(0, 20),
    sampleTitles: rows.slice(0, 15).map((r) => r.title).filter(Boolean),
  };
}

function buildPrompt(agg) {
  // Strict JSON-only instruction; we validate on the server side.
  return `You are an analyst reviewing a freshly-scraped sample of Naukri job listings
for software developer / fresher roles in India.

Below is an aggregated view of the dataset (do NOT echo raw rows, just answer from this).

=== Aggregated dataset ===
Total listings: ${agg.rowCount}
Top skills (skill:count): ${JSON.stringify(agg.topSkills)}
Top locations (location:count): ${JSON.stringify(agg.topLocations)}
Experience ranges observed: ${JSON.stringify(agg.experienceBuckets)}
Salary samples (raw strings): ${JSON.stringify(agg.salarySamples)}
Sample job titles: ${JSON.stringify(agg.sampleTitles)}
=== End dataset ===

Produce a JSON object (and ONLY JSON, no markdown, no commentary) with these keys:
{
  "topSkills": string[],                // top 10 skills, most demanded first
  "topLocations": string[],             // top 5 hiring cities/regions
  "experienceInsights": string[],       // 2-4 short observations about exp ranges (e.g. "most roles are 0-2 yrs")
  "salaryInsights": string[],           // 2-4 short observations; empty array if no salary data
  "marketSummary": string               // 2-4 sentence natural language summary of the fresher SD job market based on this data
}

Rules:
- Output strictly valid JSON.
- Don't fabricate; if a field has no signal, return an empty array / short note.
- Keep strings concise and useful for a college project demo.`;
}

function extractJson(text) {
  // Even with strict instructions, models occasionally wrap in ```json fences.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  return text.trim();
}

function safeParseJson(text) {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    // One more try: grab the first {...} block in the response.
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

// POST /analyze  — reads CSV, sends summary to Groq, returns structured insights.
router.post("/analyze", async (req, res) => {
  const csvPath = process.env.CSV_OUTPUT_PATH || path.join(__dirname, "..", "..", "data", "jobs.csv");
  const apiKey = process.env.GROQ_API_KEY;
  const model = process.env.GROQ_MODEL || "llama-3.1-70b-versatile";

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
