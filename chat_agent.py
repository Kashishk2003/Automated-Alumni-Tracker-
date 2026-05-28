import json
import os
from groq import Groq
from dotenv import load_dotenv

load_dotenv()

GROQ_KEY = os.environ["GROQ_API_KEY"]


def chat_with_agent(message: str, history: list = []) -> str:
    """
    Alumni chat agent.
    Uses the new 3-layer search engine (FTS + semantic) for retrieval.
    """
    from database import get_all_profiles
    from search import search

    # ── Search for relevant profiles ────────────────────────────────────────
    try:
        profiles = search(message, n_results=10)
    except Exception as e:
        print(f"[Chat] Search error: {e}")
        profiles = []

    # Fallback — if nothing found, use a small sample so the agent
    # can still say "no results found" meaningfully
    if not profiles:
        profiles = get_all_profiles()[:5]

    profiles = profiles[:8]

    # ── Build slim payload (controls token usage) ────────────────────────────
    slim = []
    for p in profiles:
        slim.append({
            "name":                 p.get("name", ""),
            "linkedin_url":         p.get("linkedin_url", ""),
            "current_position":     p.get("current_position", ""),
            "current_company":      p.get("current_company", ""),
            "location":             p.get("location", ""),
            "batch":                p.get("batch", ""),
            "skills":               p.get("skills", []),
            "professional_summary": p.get("professional_summary", ""),
            "achievements":         p.get("achievements", []),
            "work_history": [
                {
                    "role":        w.get("role", ""),
                    "company":     w.get("company", ""),
                    "period":      w.get("period", ""),
                    "location":    w.get("location", ""),
                    "description": w.get("description", ""),
                }
                for w in p.get("work_history", [])
            ],
            "education": p.get("education", []),
        })

    profiles_json = json.dumps(slim, indent=2)

    # ── System prompt ────────────────────────────────────────────────────────
    system_prompt = f"""You are an intelligent Alumni Network Assistant. You have access to a database of alumni profiles and help users find, analyze, and learn about alumni.

You have the following alumni data available:
{profiles_json}

Your capabilities:
- Find alumni by name, company, skills, location, or any criteria
- Answer questions about specific alumni profiles
- Compare alumni, find connections, identify trends
- Search through work history (including PAST companies, not just current)
- Identify alumni with specific skills or backgrounds
- Answer questions about the network as a whole

Rules:
- Always base your answers on the actual profile data above
- Be conversational and helpful
- When listing alumni, include their name, current role, and company
- If asked about past work history, check the work_history field carefully
- If no alumni match the query, say so clearly
- Keep responses concise but complete
- Format lists nicely with bullet points or numbered lists
- Never make up information that isn't in the profiles"""

    # ── Messages ─────────────────────────────────────────────────────────────
    messages = [{"role": "system", "content": system_prompt}]

    for h in history[-6:]:
        messages.append(h)

    messages.append({"role": "user", "content": message})

    # ── LLM call ─────────────────────────────────────────────────────────────
    client = Groq(api_key=GROQ_KEY)
    response = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=messages,
        max_tokens=1024,
        temperature=0.4,
    )

    return response.choices[0].message.content.strip()