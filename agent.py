import json
import os
import re
import requests
from groq import Groq
from datetime import datetime
from dotenv import load_dotenv

load_dotenv()

RELEVANCE_URL = os.environ["RELEVANCE_URL"]
RELEVANCE_KEY = os.environ["RELEVANCE_KEY"]
GROQ_KEY      = os.environ["GROQ_API_KEY"]

DAILY_SCRAPE_BUDGET = 10

JKLU_KEYWORDS = ["jk lakshmipat", "jklu", "j.k. lakshmipat", "jk lakshmipat university"]


def extract_batch_from_education(education: list) -> str:
    """
    Scan education entries for JKLU. Extract year range as the batch.
    E.g. 'JK Lakshmipat University, Jaipur · 2021-2025' → '2021-2025'
    Returns '' if not found.
    """
    for edu in (education or []):
        institution = (edu.get("institution") or "").lower()
        if any(kw in institution for kw in JKLU_KEYWORDS):
            year_field = (edu.get("year") or "").strip()
            # Match "2021-2025", "2021 - 2025", "2021–2025"
            match = re.search(r'(20\d{2})\s*[-\u2013\u2014]\s*(20\d{2})', year_field)
            if match:
                return f"{match.group(1)}-{match.group(2)}"
            # Single graduation year only e.g. "2025" → assume 4-yr BTech
            match = re.search(r'(20\d{2})', year_field)
            if match:
                grad = int(match.group(1))
                return f"{grad - 4}-{grad}"
    return ""


SUMMARIZE_PROMPT = """You are a LinkedIn profile data extractor. Extract structured data from the raw LinkedIn profile below.

STRICT RULES:
1. 'name': Full name only. No titles, no "Dr.", no "Mr.". If unclear, use what's most prominent.
2. 'current_position': Their latest/current job title only.
3. 'current_company': Their latest/current employer only.
4. 'timeline': Start date of CURRENT job ONLY. Format: 'Mon YYYY - Present' (e.g. 'Jun 2022 - Present'). Write '—' if not found. NEVER write a description here.
5. 'work_history': Include ALL jobs found, not just current. Each entry must have role, company, period, description.
6. 'skills': Extract from skills section AND infer from job descriptions. List individually, not as a sentence.
7. 'achievements': Only real accomplishments (awards, promotions, publications, metrics like "grew revenue by 40%"). Leave empty if none.
8. 'professional_summary': Write 2-3 sentences summarizing their career arc. Do NOT copy their bio word for word.
9. 'education': Include all degrees found.
10. Return ONLY valid JSON. No markdown, no explanation, no extra text.

JSON format:
{
  "name": "",
  "current_position": "",
  "current_company": "",
  "location": "",
  "linkedin_url": "",
  "timeline": "",
  "professional_summary": "",
  "work_history": [{"role": "", "company": "", "period": "", "description": ""}],
  "skills": [],
  "achievements": [],
  "education": [{"degree": "", "institution": "", "year": ""}]
}

Raw LinkedIn data:
"""


def _validate_and_fix(summary: dict, url: str) -> dict:
    """
    Validate the Groq output and fix common issues:
    - Missing name
    - Empty work history
    - Skills as a single string instead of list
    - timeline containing description text
    - Hallucinated linkedin_url
    """
    # Fix linkedin_url — always use the real one
    summary["linkedin_url"] = url

    # Fix name — strip titles
    name = summary.get("name", "").strip()
    for title in ["Dr.", "Mr.", "Mrs.", "Ms.", "Prof.", "Sir"]:
        name = name.replace(title, "").strip()
    summary["name"] = name

    # Fix skills — sometimes Groq returns a comma-separated string
    skills = summary.get("skills", [])
    if isinstance(skills, str):
        summary["skills"] = [s.strip() for s in skills.split(",") if s.strip()]
    elif isinstance(skills, list):
        # Flatten any nested lists or multi-skill strings
        flat = []
        for s in skills:
            if isinstance(s, str) and "," in s:
                flat.extend([x.strip() for x in s.split(",") if x.strip()])
            elif isinstance(s, str) and s.strip():
                flat.append(s.strip())
        summary["skills"] = flat

    # Fix timeline — if it has more than 6 words it's probably a description
    timeline = summary.get("timeline", "")
    if len(timeline.split()) > 6:
        summary["timeline"] = "—"

    # Fix work_history — ensure it's a list of dicts
    wh = summary.get("work_history", [])
    if not isinstance(wh, list):
        summary["work_history"] = []
    else:
        clean_wh = []
        for w in wh:
            if isinstance(w, dict) and (w.get("role") or w.get("company")):
                clean_wh.append({
                    "role":        w.get("role", "").strip(),
                    "company":     w.get("company", "").strip(),
                    "period":      w.get("period", "").strip(),
                    "description": w.get("description", "").strip(),
                })
        summary["work_history"] = clean_wh

    # Fix education
    edu = summary.get("education", [])
    if not isinstance(edu, list):
        summary["education"] = []

    # Fix achievements
    ach = summary.get("achievements", [])
    if not isinstance(ach, list):
        summary["achievements"] = []
    elif isinstance(ach, list) and len(ach) == 1 and len(ach[0]) > 200:
        # Groq sometimes dumps everything into one achievement
        summary["achievements"] = []

    # Extract JKLU batch from education
    summary["batch"] = extract_batch_from_education(summary.get("education", []))

    return summary


def _summarize_with_groq(raw_data: dict, url: str) -> dict:
    """Call Groq to summarize raw LinkedIn data, with retry on parse failure."""
    client = Groq(api_key=GROQ_KEY)

    for attempt in range(2):
        try:
            message = client.chat.completions.create(
                model="llama-3.3-70b-versatile",
                max_tokens=1500,
                temperature=0.1,   # low temp = more consistent output
                messages=[{
                    "role": "user",
                    "content": SUMMARIZE_PROMPT + json.dumps(raw_data)
                }]
            )
            raw = message.choices[0].message.content
            raw = re.sub(r"```json|```", "", raw).strip()

            # Extract JSON if there's surrounding text
            start = raw.find("{")
            end   = raw.rfind("}") + 1
            if start == -1:
                raise ValueError("No JSON object found in response")

            summary = json.loads(raw[start:end])
            return _validate_and_fix(summary, url)

        except (json.JSONDecodeError, ValueError) as e:
            print(f"[Agent] Groq parse error (attempt {attempt+1}): {e}")
            if attempt == 1:
                raise

    raise ValueError("Failed to parse Groq response after 2 attempts")


# ── Staleness scoring ─────────────────────────────────────────────────────────

def get_age_score(last_updated):
    if not last_updated:
        return 3
    days = (datetime.now() - datetime.fromisoformat(last_updated)).days
    if days >= 15:  return 3
    elif days >= 8: return 2
    elif days >= 4: return 1
    else:           return 0


# ── Core scrape + save ────────────────────────────────────────────────────────

def scrape_and_save(url: str) -> dict:
    from database import save_profile, update_scrape_order, get_all_urls
    from rag import embed_profile

    response = requests.post(
        RELEVANCE_URL,
        headers={"Content-Type": "application/json", "Authorization": RELEVANCE_KEY},
        json={"linkedin_url": url},
        timeout=60
    )
    raw_data = response.json()

    # Debug: log what Relevance AI actually returned
    print(f"[Agent] Relevance status: {response.status_code}")
    print(f"[Agent] Raw keys: {list(raw_data.keys()) if isinstance(raw_data, dict) else type(raw_data)}")

    # Check for empty or error response from scraper
    if not raw_data:
        raise ValueError(f"Scraper returned empty response for {url}")

    if isinstance(raw_data, dict):
        if raw_data.get("status") == "failed" or raw_data.get("error"):
            raise ValueError(f"Scraper error: {raw_data.get('error') or raw_data.get('message', 'unknown')}")

    summary = _summarize_with_groq(raw_data, url)

    if not summary.get("name"):
        print(f"[Agent] Raw data sample: {str(raw_data)[:500]}")
        raise ValueError(f"Could not extract name for {url} — profile may be private or scraper was blocked")

    save_profile(url, summary)
    embed_profile(summary)

    all_urls  = get_all_urls()
    max_order = max((x[2] for x in all_urls), default=0)
    update_scrape_order(url, max_order + 1)

    print(f"[Agent] ✅ Updated: {summary.get('name')}")
    return summary


# ── Background scheduler ──────────────────────────────────────────────────────

def refresh_stale_profiles():
    from database import get_all_urls

    print("[Agent] 🔄 Starting scheduled profile refresh...")
    urls = get_all_urls()
    if not urls:
        print("[Agent] No profiles found.")
        return

    scored = []
    for url, last_updated, scrape_order in urls:
        score = get_age_score(last_updated)
        if score > 0:
            scored.append((score, scrape_order, url))

    scored.sort(key=lambda x: (-x[0], x[1]))
    batch = scored[:DAILY_SCRAPE_BUDGET]
    print(f"[Agent] {len(batch)} profiles selected (budget: {DAILY_SCRAPE_BUDGET})")

    for score, order, url in batch:
        print(f"[Agent] Score {score} | Scraping: {url}")
        try:
            scrape_and_save(url)
        except Exception as e:
            print(f"[Agent] ❌ Failed: {url} — {e}")

    print("[Agent] ✅ Refresh complete.")


# ── CrewAI job matcher ────────────────────────────────────────────────────────

def match_alumni_to_job(job_description: str) -> list:
    from crewai import Agent, Task, Crew, LLM
    from crewai.tools import tool
    from database import get_all_profiles

    @tool("Get All Alumni Profiles")
    def get_alumni_tool(query: str) -> str:
        """Returns all alumni profiles as JSON for analysis."""
        profiles = get_all_profiles()
        slim = []
        for p in profiles:
            slim.append({
                "name":                 p.get("name", ""),
                "linkedin_url":         p.get("linkedin_url", ""),
                "current_position":     p.get("current_position", ""),
                "current_company":      p.get("current_company", ""),
                "location":             p.get("location", ""),
                "skills":               p.get("skills", []),
                "professional_summary": p.get("professional_summary", ""),
                "work_history": [
                    {"role": w.get("role", ""), "company": w.get("company", ""), "period": w.get("period", "")}
                    for w in p.get("work_history", [])
                ],
                "education":     p.get("education", []),
                "achievements":  p.get("achievements", []),
            })
        return json.dumps(slim)

    llm = LLM(model="groq/llama-3.3-70b-versatile", api_key=GROQ_KEY)

    recruiter = Agent(
        role="Senior Technical Recruiter",
        goal="Find the best matching alumni candidates for a given job description",
        backstory="Expert technical recruiter with 15 years of experience analyzing candidate profiles.",
        tools=[get_alumni_tool],
        llm=llm,
        verbose=True
    )

    match_task = Task(
        description=f"""Analyze all alumni profiles and find the TOP matches for this job:

JOB DESCRIPTION:
{job_description}

Steps:
1. Use the Get All Alumni Profiles tool to retrieve all profiles
2. Analyze each profile against the job requirements
3. Score candidates 0-100 based on skill match, experience, and background fit
4. Return ONLY top matches (score >= 40) as a JSON array

Return ONLY this JSON format:
[
  {{
    "name": "Full Name",
    "linkedin_url": "url",
    "match_score": 85,
    "current_position": "their current role",
    "current_company": "their current company",
    "reason": "2-3 sentence explanation of why they match"
  }}
]
Sort by match_score descending. Return ONLY valid JSON array.""",
        expected_output="A JSON array of matched alumni sorted by match score",
        agent=recruiter
    )

    crew   = Crew(agents=[recruiter], tasks=[match_task], verbose=True)
    result = crew.kickoff()
    raw    = re.sub(r"```json|```", "", str(result)).strip()

    start = raw.find("[")
    end   = raw.rfind("]") + 1
    if start == -1 or end == 0:
        return []

    matches = json.loads(raw[start:end])
    matches.sort(key=lambda x: x.get("match_score", 0), reverse=True)
    return matchess