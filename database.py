import sqlite3
import json
from datetime import datetime

DB = "alumni.db"

def init_db():
    from search import init_fts
    conn = sqlite3.connect(DB)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS profiles (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            linkedin_url TEXT UNIQUE,
            summary_json TEXT,
            last_updated TEXT,
            scrape_order INTEGER DEFAULT 0
        )
    """)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS recently_viewed (
            linkedin_url TEXT PRIMARY KEY,
            viewed_at    TEXT
        )
    """)
    conn.commit()
    init_fts(conn)
    conn.close()

def save_profile(linkedin_url, summary_json):
    from search import index_profile_fts
    conn = sqlite3.connect(DB)
    conn.execute("""
        INSERT OR REPLACE INTO profiles (linkedin_url, summary_json, last_updated)
        VALUES (?, ?, ?)
    """, (linkedin_url, json.dumps(summary_json), datetime.now().isoformat()))
    conn.commit()
    p = dict(summary_json)
    p["linkedin_url"] = linkedin_url
    index_profile_fts(conn, p)
    conn.close()

def delete_profile(linkedin_url):
    conn = sqlite3.connect(DB)
    conn.execute("DELETE FROM profiles WHERE linkedin_url = ?", (linkedin_url,))
    conn.execute("DELETE FROM recently_viewed WHERE linkedin_url = ?", (linkedin_url,))
    conn.commit()
    conn.close()

def get_profile_by_url(linkedin_url: str) -> dict | None:
    conn = sqlite3.connect(DB)
    row = conn.execute(
        "SELECT linkedin_url, summary_json, last_updated FROM profiles WHERE linkedin_url = ?",
        (linkedin_url,)
    ).fetchone()
    conn.close()
    if not row:
        return None
    try:
        p = json.loads(row[1])
        p["linkedin_url"] = row[0]
        p["last_updated"] = row[2]
        return p
    except Exception:
        return None

def get_all_profiles():
    conn = sqlite3.connect(DB)
    rows = conn.execute("""
        SELECT linkedin_url, summary_json FROM profiles
        ORDER BY json_extract(summary_json, '$.name')
    """).fetchall()
    conn.close()
    profiles = []
    for row in rows:
        try:
            p = json.loads(row[1])
            name = p.get('name', '').strip()
            if name and name.lower() != 'none' and len(name) > 1:
                p['linkedin_url'] = row[0]
                profiles.append(p)
        except:
            pass
    return profiles

def get_all_profiles_with_meta():
    """Same as get_all_profiles but includes last_updated for freshness indicator."""
    conn = sqlite3.connect(DB)
    rows = conn.execute("""
        SELECT linkedin_url, summary_json, last_updated FROM profiles
        ORDER BY json_extract(summary_json, '$.name')
    """).fetchall()
    conn.close()
    profiles = []
    for row in rows:
        try:
            p = json.loads(row[1])
            name = p.get('name', '').strip()
            if name and name.lower() != 'none' and len(name) > 1:
                p['linkedin_url'] = row[0]
                p['last_updated'] = row[2]
                profiles.append(p)
        except:
            pass
    return profiles


def get_profiles_paginated(page: int = 1, page_size: int = 100) -> dict:
    """Return profiles in pages of page_size. page starts at 1."""
    conn = sqlite3.connect(DB)
    
    # Get total count of valid profiles
    total = conn.execute("""
        SELECT COUNT(*) FROM profiles
        WHERE json_extract(summary_json, '$.name') IS NOT NULL
        AND json_extract(summary_json, '$.name') != 'none'
        AND length(json_extract(summary_json, '$.name')) > 1
    """).fetchone()[0]

    offset = (page - 1) * page_size
    rows = conn.execute("""
        SELECT linkedin_url, summary_json, last_updated FROM profiles
        ORDER BY json_extract(summary_json, '$.name')
        LIMIT ? OFFSET ?
    """, (page_size, offset)).fetchall()
    conn.close()

    profiles = []
    for row in rows:
        try:
            p = json.loads(row[1])
            name = p.get('name', '').strip()
            if name and name.lower() != 'none' and len(name) > 1:
                p['linkedin_url'] = row[0]
                p['last_updated'] = row[2]
                profiles.append(p)
        except:
            pass

    return {
        "profiles":    profiles,
        "total":       total,
        "page":        page,
        "page_size":   page_size,
        "total_pages": (total + page_size - 1) // page_size,
        "has_next":    offset + page_size < total,
        "has_prev":    page > 1,
    }

def get_all_urls():
    conn = sqlite3.connect(DB)
    rows = conn.execute("""
        SELECT linkedin_url, last_updated, scrape_order FROM profiles
    """).fetchall()
    conn.close()
    return [(row[0], row[1], row[2]) for row in rows]

def update_scrape_order(linkedin_url, order):
    conn = sqlite3.connect(DB)
    conn.execute(
        "UPDATE profiles SET scrape_order = ? WHERE linkedin_url = ?",
        (order, linkedin_url)
    )
    conn.commit()
    conn.close()

def save_recently_viewed(linkedin_url):
    conn = sqlite3.connect(DB)
    conn.execute("""
        INSERT OR REPLACE INTO recently_viewed (linkedin_url, viewed_at)
        VALUES (?, ?)
    """, (linkedin_url, datetime.now().isoformat()))
    conn.commit()
    conn.close()

def get_recently_viewed():
    conn = sqlite3.connect(DB)
    rows = conn.execute("""
        SELECT p.linkedin_url, p.summary_json
        FROM recently_viewed r
        JOIN profiles p ON r.linkedin_url = p.linkedin_url
        ORDER BY r.viewed_at DESC
        LIMIT 8
    """).fetchall()
    conn.close()
    profiles = []
    for row in rows:
        try:
            p = json.loads(row[1])
            name = p.get('name', '').strip()
            if name and name.lower() != 'none' and len(name) > 1:
                p['linkedin_url'] = row[0]
                profiles.append(p)
        except:
            pass
    return profiles

def clean_corrupt_profiles():
    conn = sqlite3.connect(DB)
    rows = conn.execute("SELECT linkedin_url, summary_json FROM profiles").fetchall()
    deleted = 0
    for row in rows:
        try:
            p = json.loads(row[1])
            name = p.get('name', '').strip()
            if not name or name.lower() == 'none' or len(name) <= 1:
                conn.execute("DELETE FROM profiles WHERE linkedin_url = ?", (row[0],))
                deleted += 1
        except:
            conn.execute("DELETE FROM profiles WHERE linkedin_url = ?", (row[0],))
            deleted += 1
    conn.commit()
    conn.close()
    return deleted


def get_all_batches() -> list:
    """
    Return a list of {batch, count} dicts sorted by batch year.
    Batch is extracted from json_extract(summary_json, '$.batch').
    Profiles with no batch get bucketed as 'Unknown'.
    """
    conn = sqlite3.connect(DB)
    rows = conn.execute("""
        SELECT json_extract(summary_json, '$.batch') as batch, COUNT(*) as cnt
        FROM profiles
        WHERE json_extract(summary_json, '$.name') IS NOT NULL
          AND json_extract(summary_json, '$.name') != 'none'
          AND length(json_extract(summary_json, '$.name')) > 1
        GROUP BY batch
    """).fetchall()
    conn.close()

    batches = []
    for row in rows:
        batch = (row[0] or "").strip() or "Unknown"
        batches.append({"batch": batch, "count": row[1]})

    # Sort: known batches by start year descending, Unknown last
    def sort_key(b):
        if b["batch"] == "Unknown":
            return (1, "")
        return (0, b["batch"])

    batches.sort(key=sort_key)
    return batches


def get_profiles_by_batch(batch: str) -> list:
    """Return all profiles belonging to a specific batch."""
    conn = sqlite3.connect(DB)
    if batch == "Unknown":
        rows = conn.execute("""
            SELECT linkedin_url, summary_json, last_updated FROM profiles
            WHERE (json_extract(summary_json, '$.batch') IS NULL
               OR json_extract(summary_json, '$.batch') = ''
               OR json_extract(summary_json, '$.batch') = 'Unknown')
              AND json_extract(summary_json, '$.name') IS NOT NULL
              AND json_extract(summary_json, '$.name') != 'none'
              AND length(json_extract(summary_json, '$.name')) > 1
            ORDER BY json_extract(summary_json, '$.name')
        """).fetchall()
    else:
        rows = conn.execute("""
            SELECT linkedin_url, summary_json, last_updated FROM profiles
            WHERE json_extract(summary_json, '$.batch') = ?
              AND json_extract(summary_json, '$.name') IS NOT NULL
              AND json_extract(summary_json, '$.name') != 'none'
              AND length(json_extract(summary_json, '$.name')) > 1
            ORDER BY json_extract(summary_json, '$.name')
        """, (batch,)).fetchall()
    conn.close()

    profiles = []
    for row in rows:
        try:
            p = json.loads(row[1])
            p['linkedin_url'] = row[0]
            p['last_updated'] = row[2]
            profiles.append(p)
        except:
            pass
    return profiles


def backfill_batches():
    """
    Re-extract batch from education for all profiles that have no batch set.
    Useful after migration. Returns count updated.
    """
    from agent import extract_batch_from_education
    conn = sqlite3.connect(DB)
    rows = conn.execute("""
        SELECT linkedin_url, summary_json FROM profiles
        WHERE json_extract(summary_json, '$.batch') IS NULL
           OR json_extract(summary_json, '$.batch') = ''
    """).fetchall()

    updated = 0
    for row in rows:
        try:
            p = json.loads(row[1])
            batch = extract_batch_from_education(p.get("education", []))
            if batch:
                p["batch"] = batch
                conn.execute(
                    "UPDATE profiles SET summary_json = ? WHERE linkedin_url = ?",
                    (json.dumps(p), row[0])
                )
                updated += 1
        except:
            pass

    conn.commit()
    conn.close()
    return updated