import sys
import os
import time
import requests as _req
from dotenv import load_dotenv

load_dotenv()

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
from collections import Counter
from database import (
    get_all_profiles, save_profile, delete_profile, init_db,
    save_recently_viewed, get_recently_viewed, clean_corrupt_profiles,
    get_all_profiles_with_meta, get_all_batches, get_profiles_by_batch,
    get_profiles_paginated, backfill_batches
)

_geocode_cache: dict = {}

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

init_db()

from rag import embed_all_profiles
embed_all_profiles()

from apscheduler.schedulers.background import BackgroundScheduler
from agent import refresh_stale_profiles

scheduler = BackgroundScheduler()
scheduler.add_job(refresh_stale_profiles, 'interval', hours=24, id='profile_refresh')
scheduler.start()
print("[Scheduler] ✅ Background profile refresh scheduled every 24 hours.")


# ── Models ───────────────────────────────────────────────────────────────────

class AddProfileRequest(BaseModel):
    linkedin_url: str

class DeleteProfileRequest(BaseModel):
    linkedin_url: str

class MatchRequest(BaseModel):
    job_description: str

class OutreachRequest(BaseModel):
    linkedin_url: str
    student_context: str = ""   # optional: student's goal/background

class PathRequest(BaseModel):
    goal: str                   # e.g. "I want to get into AI at a product startup"


# ── Core endpoints ───────────────────────────────────────────────────────────

@app.get("/")
def home():
    return {"message": "Alumni Tracker API is running"}

@app.get("/profiles")
def get_profiles(page: int = 1, page_size: int = 100):
    """
    Returns profiles paginated. Default 100 per page.
    Use ?page=2 for next page, ?page_size=50 for smaller pages.
    Use ?page=0 to get ALL profiles (for search/filter use cases).
    """
    if page == 0:
        # page=0 means return everything (for client-side search)
        profiles = get_all_profiles_with_meta()
        return {
            "profiles":    profiles,
            "total":       len(profiles),
            "page":        0,
            "page_size":   len(profiles),
            "total_pages": 1,
            "has_next":    False,
            "has_prev":    False,
        }
    return get_profiles_paginated(page=page, page_size=page_size)

@app.get("/stats")
def get_stats():
    profiles = get_all_profiles()
    companies = set(p.get("current_company", "") for p in profiles if p.get("current_company"))
    locations = set(p.get("location", "") for p in profiles if p.get("location"))
    return {
        "total_profiles": len(profiles),
        "total_companies": len(companies),
        "total_locations": len(locations),
    }

@app.post("/viewed")
def mark_viewed(request: AddProfileRequest):
    save_recently_viewed(request.linkedin_url)
    return {"message": "Saved"}

@app.get("/recently-viewed")
def recently_viewed():
    profiles = get_recently_viewed()
    return {"profiles": profiles}

@app.get("/clean")
def clean_db():
    deleted = clean_corrupt_profiles()
    return {"message": f"Cleaned {deleted} corrupt profiles"}

@app.get("/embed-all")
def embed_all():
    from rag import embed_all_profiles
    embed_all_profiles()
    return {"message": "All profiles embedded!"}

@app.get("/search")
def rag_search(q: str):
    try:
        from rag import search_profiles
        results = search_profiles(q)
        return {"profiles": results}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/add")
def add_profile(request: AddProfileRequest):
    if "linkedin.com/in/" not in request.linkedin_url:
        raise HTTPException(status_code=400, detail="Invalid URL. Must be a LinkedIn profile URL.")
    try:
        from agent import scrape_and_save
        summary = scrape_and_save(request.linkedin_url)
        return {"message": "Profile added!", "profile": summary}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/profile")
def remove_profile(request: DeleteProfileRequest):
    delete_profile(request.linkedin_url)
    return {"message": "Profile deleted!"}

@app.get("/refresh")
def manual_refresh():
    try:
        from agent import refresh_stale_profiles
        refresh_stale_profiles()
        return {"message": "Profile refresh complete!"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/match")
def match_profiles(request: MatchRequest):
    try:
        from agent import match_alumni_to_job
        matches = match_alumni_to_job(request.job_description)
        return {"matches": matches}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── NEW: Analytics ───────────────────────────────────────────────────────────

@app.get("/analytics")
def get_analytics():
    """Returns top companies, locations, skills across all alumni."""
    profiles = get_all_profiles()

    company_counter  = Counter()
    location_counter = Counter()
    skill_counter    = Counter()

    for p in profiles:
        if p.get("current_company"):
            company_counter[p["current_company"]] += 1
        if p.get("location"):
            # Simplify location to city/country
            loc = p["location"].split(",")[0].strip()
            location_counter[loc] += 1
        for skill in p.get("skills", []):
            if skill:
                skill_counter[skill.strip()] += 1

    return {
        "top_companies":  [{"name": k, "count": v} for k, v in company_counter.most_common(10)],
        "top_locations":  [{"name": k, "count": v} for k, v in location_counter.most_common(10)],
        "top_skills":     [{"name": k, "count": v} for k, v in skill_counter.most_common(15)],
    }


# ── NEW: Outreach message generator ─────────────────────────────────────────

@app.post("/outreach")
def generate_outreach(request: OutreachRequest):
    """Generate a personalised LinkedIn cold message for an alumni using Groq."""
    try:
        import json
        from groq import Groq
        from database import get_profile_by_url

        GROQ_KEY = os.environ["GROQ_API_KEY"]

        profile = get_profile_by_url(request.linkedin_url)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")

        client = Groq(api_key=GROQ_KEY)
        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            max_tokens=300,
            temperature=0.7,
            messages=[{
                "role": "user",
                "content": f"""You are helping a student write a LinkedIn cold outreach message to an alumni.

Alumni Profile:
- Name: {profile.get('name')}
- Current Role: {profile.get('current_position')} at {profile.get('current_company')}
- Location: {profile.get('location')}
- Skills: {', '.join(profile.get('skills', [])[:6])}
- Summary: {profile.get('professional_summary', '')[:300]}

Student context: {request.student_context or 'A student looking to connect and learn from this alumni.'}

Write a short, genuine, non-generic LinkedIn connection message (under 200 words).
- Reference something specific from their profile
- Be respectful and clear about what the student is hoping to learn
- End with a soft call to action (a quick call or just connecting)
- Do NOT use phrases like "I hope this message finds you well"
- Sound like a real student, not a template

Return ONLY the message text, nothing else."""
            }]
        )

        message = response.choices[0].message.content.strip()
        return {"message": message}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── NEW: Find Me a Path ──────────────────────────────────────────────────────

@app.post("/find-path")
def find_path(request: PathRequest):
    """
    Student describes their goal → RAG finds relevant alumni →
    Groq ranks and explains why each alumni is relevant to that goal.
    """
    try:
        import json
        from groq import Groq
        from rag import search_profiles

        GROQ_KEY = os.environ["GROQ_API_KEY"]

        # Step 1: RAG finds relevant alumni
        matched = search_profiles(request.goal, n_results=10)
        if not matched:
            return {"results": []}

        # Deduplicate by linkedin_url — same person can appear from multiple chunks
        seen_urls = set()
        unique = []
        for p in matched:
            key = p.get("linkedin_url") or p.get("name", "")
            if key not in seen_urls:
                seen_urls.add(key)
                unique.append(p)
            if len(unique) == 5:
                break

        # Step 2: Build slim payload for Groq
        slim = []
        for p in unique:
            slim.append({
                "name": p.get("name", ""),
                "linkedin_url": p.get("linkedin_url", ""),
                "current_position": p.get("current_position", ""),
                "current_company": p.get("current_company", ""),
                "skills": p.get("skills", [])[:5],
            })

        client = Groq(api_key=GROQ_KEY)
        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            max_tokens=800,
            temperature=0.3,
            messages=[{
                "role": "user",
                "content": f"""A student has this goal: "{request.goal}"

Here are alumni profiles that might be relevant:
{json.dumps(slim, indent=2)}

For each alumni, explain in 1-2 sentences why they are relevant to the student's goal.
Return ONLY a JSON array like this:
[
  {{
    "name": "Full Name",
    "linkedin_url": "url",
    "current_position": "role",
    "current_company": "company",
    "relevance": "1-2 sentence explanation of why this alumni is useful for the student's goal"
  }}
]
Only include alumni that are genuinely relevant. Sort by most relevant first. Return ONLY valid JSON."""
            }]
        )

        import re
        raw = response.choices[0].message.content.strip()
        raw = re.sub(r"```json|```", "", raw).strip()
        start = raw.find("[")
        end = raw.rfind("]") + 1
        results = json.loads(raw[start:end]) if start != -1 else []
        return {"results": results}

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ── NEW: Export CSV ──────────────────────────────────────────────────────────

@app.get("/export/csv")
def export_csv():
    """Download all profiles as a CSV file."""
    import csv
    import io

    profiles = get_all_profiles()
    output = io.StringIO()
    writer = csv.writer(output)

    writer.writerow(["Name", "Position", "Company", "Location", "LinkedIn URL", "Skills", "Timeline"])
    for p in profiles:
        writer.writerow([
            p.get("name", ""),
            p.get("current_position", ""),
            p.get("current_company", ""),
            p.get("location", ""),
            p.get("linkedin_url", ""),
            ", ".join(p.get("skills", [])),
            p.get("timeline", ""),
        ])

    output.seek(0)
    return StreamingResponse(
        iter([output.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=alumni_export.csv"}
    )


# ── Batch endpoints ───────────────────────────────────────────────────────────

@app.get("/batches")
def list_batches():
    """Return all graduation batches with alumni counts."""
    return {"batches": get_all_batches()}


@app.get("/batches/{batch}")
def get_batch(batch: str):
    """Return all profiles for a specific batch."""
    profiles = get_profiles_by_batch(batch)
    return {"profiles": profiles, "batch": batch, "total": len(profiles)}


@app.post("/backfill-batches")
def backfill():
    """Re-extract batch info from education for profiles missing it."""
    try:
        updated = backfill_batches()
        return {"message": f"Updated {updated} profiles"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/rebuild-fts")
def rebuild_fts_index():
    """Rebuild the full-text search index from scratch."""
    try:
        from search import rebuild_fts_index
        count = rebuild_fts_index()
        return {"message": f"FTS index rebuilt for {count} profiles"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


class MoveBatchRequest(BaseModel):
    linkedin_url: str
    new_batch: str          # ← was 'batch'; renamed to match frontend payload

class DeleteBatchRequest(BaseModel):
    batch: str

@app.post("/move-batch")
def move_batch(request: MoveBatchRequest):
    """Move a single profile to a different batch."""
    try:
        from database import get_profile_by_url
        profile = get_profile_by_url(request.linkedin_url)
        if not profile:
            raise HTTPException(status_code=404, detail="Profile not found")
        profile["batch"] = request.new_batch.strip()
        save_profile(request.linkedin_url, profile)
        return {"message": f"Moved to batch {request.new_batch}"}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/delete-batch")
def delete_batch_endpoint(request: DeleteBatchRequest):
    """Delete ALL profiles in a batch."""
    try:
        profiles = get_profiles_by_batch(request.batch)
        for p in profiles:
            delete_profile(p["linkedin_url"])
        return {"message": f"Deleted {len(profiles)} profiles from batch {request.batch}"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _geocode(location_str: str) -> tuple[float, float] | None:
    """
    Convert a location string like "Mumbai, India" → (lat, lng).
    Uses OpenStreetMap Nominatim — free, no API key needed.
    Results are cached in memory to avoid repeated calls.
    """
    if not location_str or not location_str.strip():
        return None

    # Normalise — take only first two comma-parts (e.g. "City, Country")
    parts = [p.strip() for p in location_str.split(",")]
    key   = ", ".join(parts[:2])

    if key in _geocode_cache:
        return _geocode_cache[key]

    try:
        resp = _req.get(
            "https://nominatim.openstreetmap.org/search",
            params={"q": key, "format": "json", "limit": 1},
            headers={"User-Agent": "AlumniTrackerApp/1.0"},
            timeout=5,
        )
        data = resp.json()
        if data:
            lat = float(data[0]["lat"])
            lng = float(data[0]["lon"])
            _geocode_cache[key] = (lat, lng)
            time.sleep(0.3)   # Nominatim rate-limit: max 1 req/sec
            return (lat, lng)
    except Exception as e:
        print(f"[Geocode] Failed for '{key}': {e}")

    _geocode_cache[key] = None
    return None


@app.get("/map-data")
def get_map_data():
    """
    Returns all alumni with geocoded lat/lng so the frontend can plot them on a map.
    Profiles without a parseable location are skipped.
    Each city gets a tiny random jitter so pins don't overlap.
    """
    import random
    profiles = get_all_profiles()
    result   = []

    # Group by city so we can apply jitter per-city
    city_counts: dict[str, int] = {}

    for p in profiles:
        loc = p.get("location", "")
        if not loc:
            continue

        coords = _geocode(loc)
        if not coords:
            continue

        lat, lng = coords

        # City key for jitter counting
        city_key = ", ".join([x.strip() for x in loc.split(",")][:2])
        city_counts[city_key] = city_counts.get(city_key, 0) + 1
        n = city_counts[city_key]

        # Spread pins in a small circle around city center (max ~5 km offset)
        angle  = (n * 137.5) % 360          # golden angle — evenly distributes
        radius = 0.015 * (1 + (n - 1) * 0.4)
        import math
        jitter_lat = radius * math.cos(math.radians(angle))
        jitter_lng = radius * math.sin(math.radians(angle))

        result.append({
            "name":             p.get("name", ""),
            "linkedin_url":     p.get("linkedin_url", ""),
            "current_position": p.get("current_position", ""),
            "current_company":  p.get("current_company", ""),
            "location":         loc,
            "skills":           p.get("skills", [])[:5],
            "lat":              round(lat + jitter_lat, 6),
            "lng":              round(lng + jitter_lng, 6),
            "city_lat":         lat,   # raw city center (for distance calc)
            "city_lng":         lng,
        })

    return {"alumni": result, "total": len(result)}