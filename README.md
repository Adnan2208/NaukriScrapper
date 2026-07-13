# Naukri Software-Developer Job Scraper + Groq Insights

College project: a MERN-flavoured 2-folder app that:

1. Scrapes fresher / `software developer` job listings from **Naukri** with Playwright (headless).
2. Streams results into a local `jobs.csv` (incremental writes, no data loss on crash).
3. Sends an aggregated summary of the CSV to **Groq** for structured market analysis.
4. React dashboard with 3 buttons: **Scrape**, **Download CSV**, **Analyze**.

> ⚠️ Politeness: capped sample size, randomised 2–5 s delays, captcha/login-wall detection that bails out cleanly. **No bypasses.**

## Structure
```
.
├── backend/             # Express + Playwright + Groq
│   ├── src/
│   │   ├── server.js
│   │   ├── routes/scrape.js
│   │   ├── routes/analyze.js
│   │   └── scraper/naukri.js
│   ├── data/jobs.csv    # created on first scrape
│   ├── .env.example
│   └── package.json
├── frontend/            # Vite + React UI
│   ├── src/App.jsx
│   ├── .env.example
│   └── package.json
└── package.json         # orchestrates both (concurrently)
```

## Setup
```bash
# one-shot install
npm run install:all                # runs npm install in both folders

# set secrets
cp backend/.env.example backend/.env
cp frontend/.env.example frontend/.env
# edit backend/.env  → put your GROQ_API_KEY in there
# (GROQ_MODEL optional; defaults to llama-3.1-70b-versatile)
```

## Run both in dev
```bash
# from repo root
npm run dev
```

- Backend: http://localhost:4000  (GET / for route list, /status for liveness)
- Frontend: http://localhost:5173

## How the scrape works
1. `chromium.launch({ headless: true })` → opens https://www.naukri.com
2. Types `software developer` into the role/skills input
3. Picks `0 years` / `Fresher` from the experience dropdown (leaves location blank)
4. Clicks **Search**
5. `await page.waitForSelector("article.jobTuple, …")` — no fixed sleeps
6. Scrapes cards, paginates via the next-page anchor, exits when `sampleSize` reached
7. Each row is `csvStream.write()`-ed into `backend/data/jobs.csv` — partial data survives crashes

## Endpoints

| Method | Path        | Purpose |
|--------|-------------|---------|
| POST   | `/scrape`   | Trigger Naukri run. `?sampleSize=50` (capped at 200) |
| POST   | `/analyze`  | Send aggregated CSV to Groq → structured JSON insights |
| GET    | `/download` | Stream `jobs.csv` (Content-Disposition: attachment) |
| GET    | `/status`   | Liveness: csv path, Groq key loaded, model name |

## Frontend
- **Scrape** — POSTs to `/scrape?sampleSize=N`, shows count.
- **Download** — `window.location.href = /download`, browser saves `jobs.csv`.
- **Analyze** — POSTs to `/analyze`, renders the structured insights (top skills, locations, experience, salary, market summary).

## Production-build / preview
```bash
npm run build:frontend
npm run start:frontend   # vite preview
npm run start:backend    # node src/server.js
```

## Notes
- The Groq API key never touches the frontend build — it's loaded server-side via `dotenv`.
- If Naukri shows a captcha or login wall the scraper throws a clear error and saves whatever it had so far.
- For the CSV location per requirements, `backend/data/jobs.csv` lives on your machine, not in-repo (`.gitignore`d).
