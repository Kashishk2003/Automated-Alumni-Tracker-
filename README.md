# Automated-Alumni-Tracker 
### AI-powered alumni intelligence for universities

> Automatically track, search, and analyze where your alumni are — without anyone updating anything manually.

AlumniPulse scrapes LinkedIn profiles using AI, extracts structured career data, groups alumni by graduation batch, and keeps everything fresh automatically every 24 hours. Built for JK Lakshmipat University, Jaipur.

---

## The Problem

Every university has an alumni portal. Nobody updates it. The data is stale, incomplete, and useless within a year of graduation.

AlumniPulse fixes this by removing the human dependency entirely — profiles are scraped automatically, summarized by an LLM, and refreshed on a schedule without any manual intervention.

---

## Features

- **Automatic LinkedIn scraping** — paste a URL or upload a CSV, the system does the rest
- **AI-powered data extraction** — LLaMA 3.3 70B extracts name, role, company, skills, work history, education from raw LinkedIn data
- **Batch segregation** — automatically detects JKLU graduation batches from education data (e.g. 2021-2025)
- **Semantic search** — find alumni by meaning, not just keywords ("machine learning background" finds "AI developer")
- **Strict field search** — search by current position, past experience, skills, company, or location independently
- **OR comma logic** — type "Data Science, ML, AI" to find anyone matching any of those terms
- **Analytics dashboard** — top companies, top skills, top locations across all alumni
- **Interactive map** — alumni plotted by city, click a pin to see who's there
- **Find My Path** — student describes a career goal, AI finds the most relevant alumni
- **Outreach generator** — auto-generates a personalized LinkedIn message for each alumni
- **Job matching** — paste a job description, AI scores all alumni 0-100 and returns best matches
- **Auto-refresh** — APScheduler re-scrapes the 10 most stale profiles every 24 hours automatically
- **Pagination** — loads 100 profiles at a time, scales to 1000+

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | FastAPI + Uvicorn (Python) |
| Database | SQLite |
| Vector Store | ChromaDB |
| LLM | Groq API — LLaMA 3.3 70B |
| Embeddings | BAAI/bge-large-en-v1.5 via Sentence Transformers |
| LinkedIn Scraping | Relevance AI |
| Job Matching Agent | CrewAI |
| Frontend | React.js |
| Mapping | Leaflet.js + OpenStreetMap Nominatim |
| Scheduling | APScheduler |

---

## Architecture

```
User submits LinkedIn URL
        ↓
FastAPI /add endpoint
        ↓
Relevance AI → Raw LinkedIn JSON
        ↓
Groq LLaMA 3.3 70B → Structured Profile JSON
        ↓
_validate_and_fix() → Clean Profile JSON
        ↓
extract_batch_from_education() → Batch assigned (e.g. 2021-2025)
        ↓
SQLite → Profile stored (linkedin_url as primary key)
        ↓
BGE Embedding Model → 3 chunks per profile
        ↓
ChromaDB → Stored as url::skills, url::work, url::summary
        ↓
Profile available in all views
```

---

## Project Structure

```
alumni-tracker/
├── main.py              # FastAPI app — all API endpoints
├── agent.py             # LinkedIn scraping, Groq extraction, batch detection
├── database.py          # SQLite read/write operations
├── rag.py               # ChromaDB embedding and semantic search
├── chat_agent.py        # Conversational AI interface
├── alumni.db            # SQLite database (auto-created)
├── chroma_db/           # ChromaDB vector store (auto-created)
├── .env                 # API keys (see setup)
└── alumni-frontend/     # React.js frontend
    └── src/
        └── App.js       # Complete single-file React app
```

---

## Setup

### Prerequisites

- Python 3.10+
- Node.js 18+
- A [Groq API key](https://console.groq.com) (free)
- A [Relevance AI](https://relevanceai.com) account with a LinkedIn scraper workflow

### 1. Clone the repository

```bash
git clone https://github.com/yourusername/alumnipulse.git
cd alumnipulse
```

### 2. Create a virtual environment

```bash
python -m venv venv

# Windows
venv\Scripts\activate

# Mac/Linux
source venv/bin/activate
```

### 3. Install dependencies

```bash
pip install fastapi uvicorn groq chromadb sentence-transformers \
            crewai apscheduler python-dotenv requests
```

### 4. Set up environment variables

Create a `.env` file in the root directory:

```env
GROQ_API_KEY=your_groq_api_key_here
RELEVANCE_URL=your_relevance_ai_webhook_url
RELEVANCE_KEY=your_relevance_ai_key
```

### 5. Start the backend

```bash
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

On first run this will:
- Create `alumni.db` automatically
- Load the BGE embedding model (~2GB, takes ~30 seconds first time)
- Start the 24-hour refresh scheduler

### 6. Start the frontend

```bash
cd alumni-frontend
npm install
npm start
```

Open [http://localhost:3000](http://localhost:3000)

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| GET | `/profiles` | Paginated alumni list |
| POST | `/add` | Scrape and add a LinkedIn profile |
| DELETE | `/profile` | Remove a profile |
| GET | `/search?q=` | Semantic RAG search |
| GET | `/batches` | All JKLU batches with counts |
| GET | `/batches/{batch}` | Alumni in a specific batch |
| POST | `/backfill-batches` | Re-extract batch for all profiles |
| GET | `/analytics` | Top companies, skills, locations |
| POST | `/match` | AI job description matching |
| POST | `/outreach` | Generate personalized LinkedIn message |
| POST | `/find-path` | Find alumni relevant to a student goal |
| GET | `/map-data` | Geocoded alumni for map |
| GET | `/export/csv` | Download all profiles as CSV |
| GET | `/refresh` | Manually trigger profile refresh |

---

## How Search Works

AlumniPulse has two search modes:

### Regular Search (instant)
- Runs entirely in the browser on loaded profiles
- Comma-separated OR logic — `"Python, React, ML"` finds anyone matching any term
- Strict field modes — search only in current position, past experience, skills, company, or location

### AI Search (semantic)
- Sends query to the backend RAG pipeline
- Groq extracts semantic keywords from natural language
- BGE model encodes the query as a vector
- ChromaDB finds semantically similar profile chunks
- Returns results based on meaning, not just keyword matching

Each profile is split into 3 embedding chunks for better retrieval:
- `url::skills` — skills and current role
- `url::work` — full work history
- `url::summary` — professional background and education

---

## How Batch Detection Works

When a profile is saved, the system scans the education array for JK Lakshmipat University entries. The year field is parsed using regex to extract ranges like `2021-2025`. Handles hyphen, en-dash, and em-dash separators automatically.

Profiles without a detectable JKLU entry are assigned to the `Unknown` batch.

To backfill existing profiles: **Batches page → Sync Batches**

---

## Auto-Refresh Algorithm

Every 24 hours, APScheduler scores all profiles by age:

| Age | Score |
|---|---|
| 0–3 days | 0 (skip) |
| 4–7 days | 1 |
| 8–14 days | 2 |
| 15+ days | 3 |

Top 10 most stale profiles are re-scraped automatically. Within the same score tier, profiles added earliest get priority.

---

## Environment Variables

| Variable | Description |
|---|---|
| `GROQ_API_KEY` | Groq API key for LLM inference |
| `RELEVANCE_URL` | Relevance AI webhook URL for LinkedIn scraping |
| `RELEVANCE_KEY` | Relevance AI authentication key |

---

## Roadmap

- [ ] Multi-university support
- [ ] Alumni self-update portal
- [ ] Email outreach automation
- [ ] Placement analytics by batch
- [ ] Salary trend tracking
- [ ] WhatsApp/email notification for stale profiles
- [ ] Docker deployment
- [ ] AWS production deployment guide

---

## Built With

- [FastAPI](https://fastapi.tiangolo.com)
- [ChromaDB](https://docs.trychroma.com)
- [Groq](https://console.groq.com)
- [Sentence Transformers](https://www.sbert.net)
- [CrewAI](https://docs.crewai.com)
- [Relevance AI](https://relevanceai.com)
- [React](https://react.dev)
- [Leaflet.js](https://leafletjs.com)

---

## License

MIT License — feel free to use, modify, and deploy for your institution.

---

## Author

Built by a final year B.Tech student at JK Lakshmipat University, Jaipur as a final year project.

---

*AlumniPulse — Always knowing where your alumni land.*
