import { useEffect, useState } from "react";
import "./App.css";

const BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:4000";

export default function App() {
  const [status, setStatus] = useState(null);
  const [sampleSize, setSampleSize] = useState(50);
  const [busy, setBusy] = useState(null); // 'scrape' | 'analyze' | 'download' | null
  const [scrapeResult, setScrapeResult] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [err, setErr] = useState(null);

  async function refreshStatus() {
    try {
      const r = await fetch(`${BACKEND}/status`);
      setStatus(await r.json());
    } catch (e) {
      setError(`Cannot reach backend at ${BACKEND}. Is it running?`);
    }
  }
  const setError = (m) => setErr(m);

  useEffect(() => {
    refreshStatus();
  }, []);

  async function handleScrape() {
    setBusy("scrape");
    setErr(null);
    setAnalysis(null);
    try {
      const r = await fetch(`${BACKEND}/scrape?sampleSize=${encodeURIComponent(sampleSize)}`, { method: "POST" });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setScrapeResult(data);
    } catch (e) {
      setErr(`Scrape failed: ${e.message}`);
    } finally {
      setBusy(null);
      refreshStatus();
    }
  }

  async function handleAnalyze() {
    setBusy("analyze");
    setErr(null);
    try {
      const r = await fetch(`${BACKEND}/analyze`, { method: "POST" });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setAnalysis(data);
    } catch (e) {
      setErr(`Analyze failed: ${e.message}`);
    } finally {
      setBusy(null);
    }
  }

  function handleDownload() {
    setBusy("download");
    // Direct anchor — browser handles streaming / Content-Disposition.
    window.location.href = `${BACKEND}/download`;
    setTimeout(() => setBusy(null), 1500);
  }

  return (
    <div className="page">
      <header>
        <h1>Naukri Software-Developer Job Market</h1>
        <p className="sub">
          Scrape fresher SD listings from Naukri, download the CSV, then run an
          AI-powered market analysis via Groq. Demo project — limited sample,
          polite pacing.
        </p>
      </header>

      <section className="status-card">
        <h3>Backend</h3>
        <div>{status ? (
          <ul>
            <li>CSV path: <code>{status.csvPath}</code></li>
            <li>CSV exists: {String(status.csvExists)}</li>
            <li>Groq key loaded: {String(status.hasGroqKey)}</li>
            <li>Model: <code>{status.groqModel}</code></li>
          </ul>
        ) : "loading…"}</div>
      </section>

      <section className="controls">
        <label>
          Sample size:&nbsp;
          <input
            type="number"
            min="1"
            max="200"
            value={sampleSize}
            onChange={(e) => setSampleSize(parseInt(e.target.value || "1", 10))}
          />
        </label>

        <button onClick={handleScrape} disabled={busy !== null}>
          {busy === "scrape" ? "Scraping… (1–2 min)" : "Scrape"}
        </button>
        <button onClick={handleDownload} disabled={busy !== null || !status?.csvExists}>
          {busy === "download" ? "Downloading…" : "Download CSV"}
        </button>
        <button onClick={handleAnalyze} disabled={busy !== null || !status?.csvExists}>
          {busy === "analyze" ? "Analyzing…" : "Analyze"}
        </button>
      </section>

      {err && <div className="error">{err}</div>}

      {scrapeResult && (
        <section className="card">
          <h3>Scrape result</h3>
          <pre>{JSON.stringify(scrapeResult, null, 2)}</pre>
        </section>
      )}

      {analysis && (
        <section className="card">
          <h3>AI Insights ({analysis.rowCount} jobs analyzed)</h3>
          <h4>Top Hiring Companies</h4>
          <ul>
            {(analysis.insights.topHiringCompanies || []).map((s, i) => <li key={"hc"+i}>{s}</li>)}
          </ul>
          <h4>Company Website Examples</h4>
          <ul>
            {(analysis.insights.companyWebsiteExamples || []).map((s, i) => <li key={"cw"+i}>{s}</li>)}
          </ul>
          <h4>Market Summary</h4>
          <p className="summary">{analysis.insights.marketSummary}</p>
        </section>
      )}

      <footer>
        <p>Backend: <code>{BACKEND}</code> · Run both with <code>npm install</code> + <code>npm run dev</code> at the repo root.</p>
      </footer>
    </div>
  );
}
