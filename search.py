"""
search.py — 3-layer alumni search engine

Layer 1: SQLite FTS5 (fast, exact + fuzzy)
  - Indexes name, current company, ALL past companies, ALL work locations,
    current location, skills, batch, roles
  - Works for any city/company worldwide — zero hardcoding
  - Handles "worked at Infosys 3 jobs ago" perfectly

Layer 2: ChromaDB semantic (fallback for abstract queries)
  - Only triggered when FTS returns < MIN_FTS_RESULTS
  - Handles "ML engineer in fintech", "generative AI background" etc.

Layer 3: Score merge + rank
  - FTS results get higher base score (exact signal)
  - Semantic results fill gaps
  - Profiles appearing in both get a merge bonus
"""

import sqlite3
import json
import re
from typing import Optional

DB = "alumni.db"
MIN_FTS_RESULTS = 5      # If FTS finds fewer than this, also run semantic
MAX_RESULTS = 50


# ─────────────────────────────────────────────────────────────
# FTS5 Setup — called once from init_db() in database.py
# ─────────────────────────────────────────────────────────────

def init_fts(conn: sqlite3.Connection):
    """
    Create FTS5 virtual table and populate it.
    Safe to call multiple times — uses CREATE IF NOT EXISTS.
    """
    conn.execute("""
        CREATE VIRTUAL TABLE IF NOT EXISTS profiles_fts USING fts5(
            linkedin_url UNINDEXED,
            name,
            current_company,
            current_role,
            location,
            all_companies,
            all_roles,
            all_locations,
            skills,
            batch,
            summary,
            tokenize='porter unicode61'
        )
    """)
    conn.commit()


def index_profile_fts(conn: sqlite3.Connection, p: dict):
    """
    Index a single profile into FTS5.
    Extracts ALL past companies, roles, and locations from work_history.
    Called after every save_profile().
    """
    linkedin_url = p.get("linkedin_url", "")
    name         = p.get("name", "")
    location     = p.get("location", "").lower()
    batch        = p.get("batch", "")
    summary      = p.get("professional_summary", "")

    current_company = p.get("current_company", "").lower()
    current_role    = p.get("current_position", "").lower()

    # Collect ALL companies, roles, locations from full work history
    all_companies = [current_company] if current_company else []
    all_roles     = [current_role] if current_role else []
    all_locations = [location] if location else []

    for w in p.get("work_history", []):
        c = (w.get("company") or "").strip().lower()
        r = (w.get("role") or "").strip().lower()
        l = (w.get("location") or "").strip().lower()
        if c and c not in all_companies:
            all_companies.append(c)
        if r and r not in all_roles:
            all_roles.append(r)
        if l and l not in all_locations:
            all_locations.append(l)

    skills_str = " ".join(s.lower() for s in p.get("skills", []))

    # Delete old entry first (upsert pattern for FTS5)
    conn.execute(
        "DELETE FROM profiles_fts WHERE linkedin_url = ?",
        (linkedin_url,)
    )
    conn.execute(
        """INSERT INTO profiles_fts
           (linkedin_url, name, current_company, current_role, location,
            all_companies, all_roles, all_locations, skills, batch, summary)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (
            linkedin_url,
            name.lower(),
            current_company,
            current_role,
            location,
            " ".join(all_companies),   # "infosys tcs capgemini google"
            " ".join(all_roles),       # "engineer analyst intern lead"
            " ".join(all_locations),   # "bangalore pune delhi toronto"
            skills_str,
            batch.lower(),
            summary.lower(),
        )
    )
    conn.commit()


def rebuild_fts_index():
    """
    Rebuild the entire FTS index from scratch.
    Run this once after migration, or call /rebuild-fts endpoint.
    """
    conn = sqlite3.connect(DB)

    # Drop and recreate — handles migration from old contentless table
    conn.execute("DROP TABLE IF EXISTS profiles_fts")
    conn.commit()
    init_fts(conn)

    rows = conn.execute(
        "SELECT linkedin_url, summary_json FROM profiles"
    ).fetchall()

    count = 0
    for row in rows:
        try:
            p = json.loads(row[1])
            p["linkedin_url"] = row[0]
            name = p.get("name", "").strip()
            if not name or name.lower() == "none":
                continue
            index_profile_fts(conn, p)
            count += 1
        except Exception as e:
            print(f"[FTS] Failed to index {row[0]}: {e}")

    conn.close()
    print(f"[FTS] Indexed {count} profiles.")
    return count


# ─────────────────────────────────────────────────────────────
# Intent Extraction — LLM, no hardcoding
# ─────────────────────────────────────────────────────────────

def _extract_intent(query: str) -> dict:
    """
    Use Groq to parse any natural language query into structured fields.
    Falls back to raw query on failure (still works via FTS full-text).
    """
    import os
    from groq import Groq

    empty = {
        "names": [], "companies": [], "locations": [],
        "skills": [], "positions": [], "batches": [],
        "raw": query
    }

    try:
        client = Groq(api_key=os.environ["GROQ_API_KEY"])
        resp = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            max_tokens=200,
            temperature=0.0,
            messages=[{
                "role": "user",
                "content": f"""Parse this alumni search query into structured fields.
Return ONLY valid JSON, no markdown, no explanation.

Fields:
- names: person names mentioned (e.g. ["rahul", "akshat sharma"])
- companies: any company names, current OR past (e.g. ["google", "infosys"])
- locations: any cities, states, countries (e.g. ["bangalore", "paris"])
- skills: technologies or domain skills (e.g. ["python", "machine learning"])
- positions: job titles or roles (e.g. ["software engineer", "data analyst"])
- batches: graduation batch years (e.g. ["2021-2025", "2020"])

Examples:
"find rahul who worked at infosys"
{{"names":["rahul"],"companies":["infosys"],"locations":[],"skills":[],"positions":[],"batches":[]}}

"python developers in paris from 2021 batch"
{{"names":[],"companies":[],"locations":["paris"],"skills":["python"],"positions":[],"batches":["2021"]}}

"who used to work at tcs bangalore"
{{"names":[],"companies":["tcs"],"locations":["bangalore"],"skills":[],"positions":[],"batches":[]}}

Query: "{query}"
Output:"""
            }]
        )
        raw    = resp.choices[0].message.content.strip()
        result = json.loads(raw)
        result["raw"] = query
        print(f"[Search] Intent: {result}")
        return result

    except Exception as e:
        print(f"[Search] Intent extraction failed: {e} — using raw query")
        return empty


# ─────────────────────────────────────────────────────────────
# Layer 1: FTS Search
# ─────────────────────────────────────────────────────────────

def _fts_search(intent: dict) -> dict:
    """
    SQLite FTS5 search across all indexed fields.
    Returns dict: linkedin_url -> (profile_meta, score, [reasons])

    Scoring:
    - Name match:        +5  (highest — very specific signal)
    - Company match:     +3  (current OR past — both indexed)
    - Location match:    +3  (current OR work location)
    - Skill match:       +2
    - Position match:    +2
    - Batch match:       +2
    - Full-text match:   +1  (raw query fallback)
    """
    conn = sqlite3.connect(DB)
    results = {}  # linkedin_url -> (meta, score, reasons)

    def _run(field: str, terms: list, score: int, label: str):
        for term in terms:
            if not term or not term.strip():
                continue
            try:
                # FTS5 query: field-specific match
                fts_query = f'"{term}"' if " " in term else term
                rows = conn.execute(
                    f"""SELECT f.linkedin_url, p.summary_json
                        FROM profiles_fts f
                        JOIN profiles p ON f.linkedin_url = p.linkedin_url
                        WHERE profiles_fts MATCH '{field}:{fts_query}'
                        ORDER BY rank
                        LIMIT 100""",
                ).fetchall()

                for row in rows:
                    url  = row[0]
                    meta = _slim_meta(row[1], url)
                    if url in results:
                        old_meta, old_score, old_reasons = results[url]
                        results[url] = (meta, old_score + score, old_reasons + [f"{label}:{term}"])
                    else:
                        results[url] = (meta, score, [f"{label}:{term}"])

            except Exception as e:
                print(f"[FTS] Query failed ({label}:{term}): {e}")

    # Run field-specific searches based on intent
    _run("name",          intent.get("names", []),      5, "name")
    _run("all_companies", intent.get("companies", []),  3, "company")
    _run("location",      intent.get("locations", []),  3, "location")
    _run("all_locations", intent.get("locations", []),  3, "work_location")
    _run("skills",        intent.get("skills", []),     2, "skill")
    _run("all_roles",     intent.get("positions", []),  2, "role")
    _run("batch",         intent.get("batches", []),    2, "batch")

    # If intent extraction found nothing, run raw full-text search
    has_intent = any(
        intent.get(k) for k in ["names", "companies", "locations", "skills", "positions", "batches"]
    )
    if not has_intent and intent.get("raw"):
        try:
            raw_terms = " ".join(
                w for w in intent["raw"].lower().split()
                if len(w) > 2 and w not in {"the", "who", "has", "and", "for", "with", "from", "that", "are"}
            )
            if raw_terms:
                rows = conn.execute(
                    """SELECT f.linkedin_url, p.summary_json
                       FROM profiles_fts f
                       JOIN profiles p ON f.linkedin_url = p.linkedin_url
                       WHERE profiles_fts MATCH ?
                       ORDER BY rank
                       LIMIT 50""",
                    (raw_terms,)
                ).fetchall()
                for row in rows:
                    url  = row[0]
                    meta = _slim_meta(row[1], url)
                    if url not in results:
                        results[url] = (meta, 1, ["fulltext"])
        except Exception as e:
            print(f"[FTS] Raw search failed: {e}")

    conn.close()
    print(f"[Search] FTS matched: {len(results)} profiles")
    return results


def _slim_meta(summary_json: str, url: str) -> dict:
    """Extract just the metadata fields we need for ranking."""
    try:
        p = json.loads(summary_json)
        return {
            "name":             p.get("name", ""),
            "current_position": p.get("current_position", ""),
            "current_company":  p.get("current_company", ""),
            "location":         p.get("location", ""),
            "linkedin_url":     url,
            "skills":           p.get("skills", []),
            "batch":            p.get("batch", ""),
        }
    except Exception:
        return {"linkedin_url": url}


# ─────────────────────────────────────────────────────────────
# Layer 2: Semantic Search (fallback)
# ─────────────────────────────────────────────────────────────

def _semantic_search(query: str, existing: dict) -> dict:
    """
    ChromaDB semantic search — only runs when FTS finds too few results.
    Fills in gaps for abstract queries FTS can't handle well.
    """
    try:
        from rag import search_profiles as rag_search
        semantic_results = rag_search(query, n_results=30)

        added = 0
        for p in semantic_results:
            url = p.get("linkedin_url") or p.get("name", "")
            if not url:
                continue
            if url not in existing:
                meta = {
                    "name":             p.get("name", ""),
                    "current_position": p.get("current_position", ""),
                    "current_company":  p.get("current_company", ""),
                    "location":         p.get("location", ""),
                    "linkedin_url":     url,
                    "skills":           p.get("skills", []),
                    "batch":            p.get("batch", ""),
                }
                existing[url] = (meta, 0.5, ["semantic"])
                added += 1
            else:
                # Already found via FTS — small bonus for appearing in both
                old_meta, old_score, old_reasons = existing[url]
                existing[url] = (old_meta, old_score + 0.3, old_reasons + ["semantic"])

        print(f"[Search] Semantic added {added} new profiles")
    except Exception as e:
        print(f"[Search] Semantic search failed: {e}")

    return existing


# ─────────────────────────────────────────────────────────────
# Layer 3: Hydrate full profiles
# ─────────────────────────────────────────────────────────────

def _hydrate(top_metas: list) -> list:
    """Fetch full profiles from SQLite for the top ranked results."""
    try:
        from database import get_profile_by_url
        hydrated = []
        for meta in top_metas:
            url  = meta.get("linkedin_url")
            full = get_profile_by_url(url) if url else None
            hydrated.append(full if full else meta)
        return hydrated
    except Exception as e:
        print(f"[Search] Hydration failed: {e}")
        return top_metas


# ─────────────────────────────────────────────────────────────
# Main Search Entry Point
# ─────────────────────────────────────────────────────────────

def search(query: str, n_results: int = MAX_RESULTS) -> list:
    """
    Main search function. Drop-in replacement for rag.search_profiles().

    Flow:
    1. Extract intent via LLM (no hardcoded lists)
    2. FTS5 search — name, company (current+past), location (current+work),
       skills, roles, batch. All indexed, any city/company works.
    3. If FTS < MIN_FTS_RESULTS → also run semantic search
    4. Rank by score, hydrate full profiles
    """
    if not query or not query.strip():
        return []

    # 1 — Intent
    intent = _extract_intent(query)

    # 2 — FTS (primary)
    profile_scores = _fts_search(intent)

    # 3 — Semantic fallback
    if len(profile_scores) < MIN_FTS_RESULTS:
        print(f"[Search] FTS returned {len(profile_scores)} — triggering semantic fallback")
        profile_scores = _semantic_search(query, profile_scores)

    # 4 — Sort by score
    sorted_profiles = sorted(
        profile_scores.values(), key=lambda x: x[1], reverse=True
    )
    print(f"[Search] Final unique matches: {len(sorted_profiles)}")

    top_metas = [meta for meta, score, _ in sorted_profiles[:n_results]]

    # 5 — Hydrate
    return _hydrate(top_metas)