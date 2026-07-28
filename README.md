# LeadPulse AI ⚡

> **Next-Gen Autonomous B2B Lead Discovery, Puppeteer + Cheerio Scraping & 5-Dimension AI Scoring Platform**

LeadPulse AI automates outbound B2B sales prospecting by crawling live web sources, detecting real buying intent signals using **Puppeteer + Cheerio**, enriching decision-maker contact details, and computing 0–100 match scores using a **5-dimension AI scoring engine** with **Groq LLM (Llama-3.3-70B)** explanations.

---

## 🚀 Key Features

- **🌐 Deep Web Scraping (Puppeteer + Cheerio)**: Launches headless browser sessions with Puppeteer to search duckduckgo and web targets, parsing search engine DOMs and company web pages with Cheerio selectors. Includes an automatic HTTP fallback engine.
- **📰 Multi-Source Intent Monitoring**:
  - **News & PR Signals**: Google News RSS feeds parsed via Cheerio XML mode.
  - **Live Hiring Signals**: RemoteOK, Jobicy, and HackerNews Who's Hiring board scrapers.
  - **Social Pain-Point Discussions**: Reddit subreddits monitoring via JSON API & RSS Cheerio parser.
- **📊 5-Dimension AI Lead Scoring Model**:
  - **Intent Signals (30%)**: Live job postings, news expansions, social mentions, and web signals.
  - **Profile Fit (25%)**: Decision-maker title match (CTO, VP Eng, Director) against target ICP.
  - **Company Fit (20%)**: Industry alignment, company size bounds, and geography.
  - **Recency Decay (15%)**: Exponential signal decay (14-day half-life).
  - **Engagement History (10%)**: Status progression and manual user interactions.
- **⚡ Groq AI (Llama-3.3-70B) Score Insights**: Generates instant, 2-3 sentence plain-language score breakdown cards for sales reps.
- **🔒 Deduplication Engine**: SHA-256 hash deduplication to eliminate duplicate leads across channels.

---

## 🏗 Architecture

```
leadpulse-ai/
├── backend/                    # Node.js + Express API
│   ├── config/                 # Database, Redis, env config
│   ├── models/                 # Lead, ICP, ScoreHistory, Signal
│   ├── services/
│   │   ├── discovery/          # Puppeteer + Cheerio scrapers (Web, News, Job, Social) + AI Extractor + Enrichment + Dedup
│   │   ├── scoring/            # 5-dimension scorer + Groq/Claude explainer + tier mapper
│   │   └── queue/              # Bull queues for background discovery jobs
│   ├── routes/                 # REST API endpoints (discovery, scoring, leads, icp)
│   ├── middleware/             # Auth & headers handler
│   └── migrations/             # PostgreSQL schema
├── frontend/                   # Real-time Glassmorphism Dashboard
│   ├── index.html              # Main OS control panel
│   ├── css/styles.css          # Design system & dark mode styles
│   └── js/                     # App, Views, Filters, Charts, Modal
└── README.md                   # Project documentation
```

---

## 🔍 Web Scraping Engine (Puppeteer + Cheerio)

LeadPulse AI relies on a hybrid scraping engine:

1. **Puppeteer Navigation**: Headless Chromium browser visits search engine targets (`https://html.duckduckgo.com/html/?q=...`) and target technology company sites.
2. **Cheerio DOM Parsing**: Parses the HTML DOM tree using fast jQuery-like selectors (`.result__title`, `.result__snippet`, `.result__url`) to extract title, snippet, URL, and company info.
3. **RSS & XML Parser**: Parses Google News and Reddit RSS feeds in Cheerio XML mode (`cheerio.load(xml, { xmlMode: true })`).
4. **Fallback Scraping**: High-concurrency Axios + Cheerio HTTP fallback when headless browser execution faces environment restrictions.

---

## 📊 5-Dimension Scoring Engine

Every discovered prospect is evaluated across 5 weighted dimensions:

| Dimension | Weight | Description |
|-----------|--------|-------------|
| **Intent Signals** | **30%** | Live job postings (+35), news mentions (+25), social mentions (+20), web mentions (+20) |
| **Profile Fit** | **25%** | Decision maker title match (Exact +95, Partial +80, Seniority +70) |
| **Company Fit** | **20%** | Industry match (+35), size match (+25), geography match (+20), website (+5) |
| **Recency Decay** | **15%** | Exponential signal decay based on discovery date |
| **Engagement** | **10%** | Pipeline status (`accepted` +80, `reviewed` +50, `scored` +20) |

### Tiers
- 🔥 **Hot Tier**: `70 – 100` Match Score
- 🌤️ **Warm Tier**: `40 – 69` Match Score
- ❄️ **Cold Tier**: `0 – 39` Match Score

---

## 🔌 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/health` | Server health check |
| `POST` | `/api/discovery/run/:icpId` | Trigger multi-source discovery run for an ICP |
| `GET` | `/api/discovery/status/:jobId` | Check real-time discovery job progress |
| `GET` | `/api/leads` | List leads (filtered by ICP, status, tier, source, search) |
| `GET` | `/api/leads/stats` | Aggregate pipeline lead stats by tier and source |
| `GET` | `/api/leads/:id` | Full lead detail with signals timeline & score breakdown |
| `POST` | `/api/scoring/rescore/:leadId` | Trigger manual rescore for a lead |
| `POST` | `/api/scoring/override/:leadId` | Manually override a lead score with notes |
| `POST` | `/api/icp` | Create a target Ideal Customer Profile (ICP) |
| `GET` | `/api/icp` | List active Ideal Customer Profiles |

---

## 🛠 Tech Stack

- **Backend**: Node.js, Express, PostgreSQL, Redis, Bull Queue
- **Web Scraping**: **Puppeteer**, **Cheerio**, Axios
- **AI & Entity Extraction**: Groq API (`llama-3.3-70b-versatile`), Claude API
- **Contact Enrichment**: Apollo.io API, Hunter.io API, Contact Synthesizer
- **Frontend**: Vanilla JS (ES6+), HTML5, CSS3 Glassmorphism, Chart.js

---

## 🚀 Quick Start

### 1. Start Frontend Server
```bash
cd frontend
node serve_frontend.js
# Opens at http://localhost:5500
```

### 2. Start Backend Server
```bash
cd backend
npm install
npm run dev
# Server running at http://localhost:3000
```

---

*Built by Asan Innovators © 2026*
