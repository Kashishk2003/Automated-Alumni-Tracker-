import os
import re
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

CHROMA_PATH = "./chroma_db"
COLLECTION_NAME = "alumni_profiles"
MODEL_NAME = "BAAI/bge-large-en-v1.5"   # better than MiniLM for professional text
GROQ_KEY = os.environ["GROQ_API_KEY"]
SIMILARITY_THRESHOLD = 0.55   # bge scores higher than MiniLM so threshold is higher
MAX_RESULTS = 10

_model     = None
_client    = None
_collection = None


def get_model():
    global _model
    if _model is None:
        from sentence_transformers import SentenceTransformer
        # BGE models need a query prefix for better retrieval accuracy
        _model = SentenceTransformer(MODEL_NAME)
    return _model


def get_collection():
    global _client, _collection
    if _collection is None:
        import chromadb
        _client     = chromadb.PersistentClient(path=CHROMA_PATH)
        _collection = _client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"}
        )
    return _collection


# ── Build weighted text chunks ────────────────────────────────────────────────
# Instead of one flat blob, we build 3 focused chunks per profile.
# Each chunk is stored separately so the query hits the most relevant one.

def _build_chunks(p: dict) -> dict:
    """
    Returns 3 chunks:
      - skills_chunk:   skills + current role (repeated for emphasis)
      - work_chunk:     full work history with company names prominent
      - summary_chunk:  overall profile summary + education + achievements
    """
    name     = p.get("name", "")
    role     = p.get("current_position", "")
    company  = p.get("current_company", "")
    location = p.get("location", "")
    skills   = p.get("skills", [])
    summary  = p.get("professional_summary", "")

    # Work history
    work_parts = []
    for w in p.get("work_history", []):
        r = w.get("role", "")
        c = w.get("company", "")
        period = w.get("period", "")
        desc   = w.get("description", "")
        entry  = f"{r} at {c}"
        if period: entry += f" ({period})"
        if desc:   entry += f" — {desc}"
        work_parts.append(entry)

    # Education
    edu_parts = []
    for e in p.get("education", []):
        edu_parts.append(f"{e.get('degree','')} from {e.get('institution','')} {e.get('year','')}")

    skills_str = ", ".join(skills)

    # ── Chunk 1: Skills — repeat skills + role 2x so BERT weights them higher
    skills_chunk = (
        f"Name: {name}\n"
        f"Current Role: {role} at {company}\n"
        f"Location: {location}\n"
        f"Skills: {skills_str}\n"
        f"Technologies and expertise: {skills_str}\n"   # intentional repeat for weighting
        f"Works as: {role}"
    )

    # ── Chunk 2: Work history — company names front and center
    work_chunk = (
        f"Name: {name}\n"
        f"Current Role: {role} at {company}\n"
        f"Work Experience:\n" + "\n".join(f"- {w}" for w in work_parts)
    )

    # ── Chunk 3: Summary — overall context
    summary_chunk = (
        f"Name: {name}\n"
        f"Professional Background: {summary}\n"
        f"Education: {' | '.join(edu_parts)}\n"
        f"Achievements: {' | '.join(p.get('achievements', []))}"
    )

    return {
        "skills":  skills_chunk.strip(),
        "work":    work_chunk.strip(),
        "summary": summary_chunk.strip(),
    }


# ── Embed one profile (3 chunks) ──────────────────────────────────────────────

def embed_profile(p: dict):
    doc_id = p.get("linkedin_url") or p.get("name", "")
    if not doc_id:
        return

    model      = get_model()
    collection = get_collection()
    chunks     = _build_chunks(p)

    meta = {
        "name":         p.get("name", ""),
        "position":     p.get("current_position", ""),
        "company":      p.get("current_company", ""),
        "location":     p.get("location", ""),
        "linkedin_url": p.get("linkedin_url", ""),
    }

    # Store as 3 separate docs with suffixed IDs
    ids        = [f"{doc_id}::skills", f"{doc_id}::work", f"{doc_id}::summary"]
    documents  = [chunks["skills"], chunks["work"], chunks["summary"]]
    embeddings = [model.encode(d, normalize_embeddings=True).tolist() for d in documents]
    metadatas  = [meta, meta, meta]   # same meta for all 3 chunks

    collection.upsert(
        ids=ids,
        embeddings=embeddings,
        documents=documents,
        metadatas=metadatas,
    )


# ── Re-embed ALL profiles ─────────────────────────────────────────────────────

def embed_all_profiles():
    from database import get_all_profiles

    profiles = get_all_profiles()
    if not profiles:
        print("[RAG] No profiles found in DB.")
        return

    model      = get_model()
    collection = get_collection()

    # ── Find which profiles are already embedded ──────────────────────────────
    existing_ids = set(collection.get(include=[])["ids"])
    
    ids, embeddings, documents, metadatas = [], [], [], []
    skipped = 0

    for p in profiles:
        doc_id = p.get("linkedin_url") or p.get("name", "")
        if not doc_id:
            continue

        # Skip if all 3 chunks already exist in ChromaDB
        if all(f"{doc_id}::{s}" in existing_ids for s in ("skills", "work", "summary")):
            skipped += 1
            continue

        chunks = _build_chunks(p)
        meta   = {
            "name":         p.get("name", ""),
            "position":     p.get("current_position", ""),
            "company":      p.get("current_company", ""),
            "location":     p.get("location", ""),
            "linkedin_url": p.get("linkedin_url", ""),
        }

        for suffix, text in [("skills", chunks["skills"]), ("work", chunks["work"]), ("summary", chunks["summary"])]:
            ids.append(f"{doc_id}::{suffix}")
            embeddings.append(model.encode(text, normalize_embeddings=True).tolist())
            documents.append(text)
            metadatas.append(meta)

    if ids:
        collection.upsert(ids=ids, embeddings=embeddings, documents=documents, metadatas=metadatas)

    newly_embedded = len(ids) // 3
    print(f"[RAG] ✅ Embedded {newly_embedded} new profiles | ⏭ Skipped {skipped} already embedded | Total: {len(profiles)}")


# ── Groq keyword extractor ────────────────────────────────────────────────────

def _extract_keywords(query: str) -> list[str]:
    try:
        client   = Groq(api_key=GROQ_KEY)
        response = client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            max_tokens=80,
            temperature=0.0,
            messages=[{
                "role": "user",
                "content": (
                    f'User is searching an alumni database: "{query}"\n\n'
                    "Extract concrete keywords — job titles, skills, tools, technologies, company names, "
                    "industries — that would appear in a matching LinkedIn profile.\n"
                    "Rules:\n"
                    "- Return ONLY comma-separated keywords, nothing else\n"
                    "- 1-3 words each\n"
                    "- Include synonyms and related terms\n"
                    "- No explanations"
                )
            }]
        )
        raw      = response.choices[0].message.content.strip()
        keywords = [k.strip() for k in raw.split(",") if k.strip()]
        print(f"[RAG] Keywords: {keywords}")
        return keywords
    except Exception as e:
        print(f"[RAG] Keyword extraction failed: {e}")
        return query.strip().split()


# ── Named entity detection ────────────────────────────────────────────────────

def _is_named_entity(query: str) -> bool:
    """True if query looks like a company/person name — skip Groq, do direct search."""
    words  = query.strip().split()
    capped = sum(1 for w in words if w and w[0].isupper())
    return capped >= max(1, len(words) - 1)


# ── Keyword search across stored chunks ──────────────────────────────────────

def _keyword_search(collection, keywords: list[str]) -> list[dict]:
    results   = collection.get(include=["documents", "metadatas"])
    docs      = results.get("documents", [])
    metadatas = results.get("metadatas", [])

    score_map: dict[str, tuple[int, dict]] = {}

    for keyword in keywords:
        pattern = re.compile(rf'\b{re.escape(keyword.lower())}\b')
        for doc, meta in zip(docs, metadatas):
            if pattern.search(doc.lower()):
                key = meta.get("linkedin_url") or meta.get("name", "")
                if key in score_map:
                    score_map[key] = (score_map[key][0] + 1, meta)
                else:
                    score_map[key] = (1, meta)

    min_hits    = 2 if len(keywords) >= 4 else 1
    filtered    = [(count, meta) for count, meta in score_map.values() if count >= min_hits]
    sorted_hits = sorted(filtered, key=lambda x: x[0], reverse=True)
    print(f"[RAG] Keyword hits: {len(sorted_hits)} (min_hits={min_hits})")
    return [meta for _, meta in sorted_hits]


# ── Main search ───────────────────────────────────────────────────────────────

def search_profiles(query: str, n_results: int = MAX_RESULTS) -> list:
    """
    Flow:
    1. Named entity (company/person name) → direct phrase search in chunks
    2. Otherwise → Groq extracts keywords → keyword search on chunks
    3. Always → BGE semantic search across all chunks, de-duplicate by profile
    4. Hydrate full profiles from SQLite
    """
    if not query or not query.strip():
        return []

    collection = get_collection()
    total      = collection.count()
    if total == 0:
        print("[RAG] Collection is empty.")
        return []

    seen:          set[str]   = set()
    final_results: list[dict] = []

    # ── Stage 1: Named entity → direct phrase search ──────────────────────
    if _is_named_entity(query):
        print(f"[RAG] Named entity detected: '{query}'")
        all_docs  = collection.get(include=["documents", "metadatas"])
        docs      = all_docs.get("documents", [])
        metas     = all_docs.get("metadatas", [])
        phrase    = query.strip().lower()
        for doc, meta in zip(docs, metas):
            if phrase in doc.lower():
                key = meta.get("linkedin_url") or meta.get("name", "")
                if key not in seen:
                    seen.add(key)
                    final_results.append(meta)
        print(f"[RAG] Direct phrase hits: {len(final_results)}")
        keywords = query.strip().split()
    else:
        # ── Stage 2: Groq keyword extraction + keyword search ─────────────
        keywords     = _extract_keywords(query)
        keyword_hits = _keyword_search(collection, keywords)
        for meta in keyword_hits:
            key = meta.get("linkedin_url") or meta.get("name", "")
            if key not in seen:
                seen.add(key)
                final_results.append(meta)

    # ── Stage 3: BGE semantic search across all chunks ────────────────────
    # BGE models work best with "Represent this sentence: " prefix on queries
    prefixed_query  = f"Represent this sentence: {', '.join(keywords) if not _is_named_entity(query) else query}"
    query_embedding = get_model().encode(prefixed_query, normalize_embeddings=True).tolist()

    # Fetch more than needed since chunks are 3x the profile count
    n_chunks = min(n_results * 3, total)
    results  = collection.query(
        query_embeddings=[query_embedding],
        n_results=n_chunks,
        include=["metadatas", "distances"],
    )
    metadatas = results.get("metadatas", [[]])[0]
    distances = results.get("distances", [[]])[0]

    for meta, dist in zip(metadatas, distances):
        similarity = 1 - (dist / 2)
        print(f"[RAG] {meta.get('name')} → {similarity:.4f}")

        if similarity < SIMILARITY_THRESHOLD:
            continue

        key = meta.get("linkedin_url") or meta.get("name", "")
        if key not in seen:
            seen.add(key)
            final_results.append(meta)

    print(f"[RAG] Total: {len(final_results)}")
    slim = final_results[:n_results]

    # ── Stage 4: Hydrate from SQLite ──────────────────────────────────────
    try:
        from database import get_profile_by_url
        return [get_profile_by_url(m.get("linkedin_url") or m.get("name", "")) or m for m in slim]
    except Exception as e:
        print(f"[RAG] Hydration failed: {e}")
        return slim