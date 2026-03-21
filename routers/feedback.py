"""Feedback API — submit, list, and manage user feedback.

POST /api/feedback        — submit feedback
GET  /api/feedback        — list feedback (newest first, filterable)
PATCH /api/feedback/{id}  — update status/notes (admin)
"""
import html
import time
from datetime import datetime, timezone
from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel, Field

from db import get_connection

router = APIRouter(prefix="/api/feedback", tags=["feedback"])

# Rate limit: 1 submission per 10 seconds per IP
_rate_limit: dict[str, float] = {}
RATE_LIMIT_SEC = 10
MAX_MESSAGE_LEN = 2000
VALID_CATEGORIES = {"bug", "idea", "improvement", "confusion", "other"}
VALID_STATUSES = {"new", "reviewed", "planned", "done", "dismissed"}


class FeedbackSubmit(BaseModel):
    message: str = Field(..., min_length=1, max_length=MAX_MESSAGE_LEN)
    category: str = Field(default="other")
    page_context: str = Field(default="", max_length=200)


class FeedbackUpdate(BaseModel):
    status: str = Field(default=None)
    notes: str = Field(default=None, max_length=1000)


@router.post("")
async def submit_feedback(body: FeedbackSubmit, request: Request):
    """Submit user feedback."""
    # Rate limit by IP
    client_ip = request.client.host if request.client else "unknown"
    now = time.time()
    last = _rate_limit.get(client_ip, 0)
    if now - last < RATE_LIMIT_SEC:
        raise HTTPException(status_code=429, detail="Please wait before submitting again")
    _rate_limit[client_ip] = now

    # Validate category
    category = body.category.strip().lower()
    if category not in VALID_CATEGORIES:
        category = "other"

    # Sanitize message
    message = body.message.strip()
    if not message:
        raise HTTPException(status_code=400, detail="Message cannot be empty")

    # Sanitize for storage (prevent stored XSS)
    message = html.escape(message)
    page_context = html.escape(body.page_context.strip()) if body.page_context else ""
    user_agent = request.headers.get("user-agent", "")[:500]

    created_at = datetime.now(timezone.utc).isoformat()

    db = await get_connection()
    try:
        cursor = await db.execute(
            """INSERT INTO feedback (created_at, message, category, page_context, user_agent, status)
               VALUES (?, ?, ?, ?, ?, 'new')""",
            (created_at, message, category, page_context, user_agent),
        )
        await db.commit()
        return {"id": cursor.lastrowid, "status": "saved"}
    except Exception as e:
        raise HTTPException(status_code=500, detail="Failed to save feedback")
    finally:
        await db.close()

    # Cleanup rate limit (keep bounded)
    if len(_rate_limit) > 500:
        cutoff = now - 60
        _rate_limit.clear()


@router.get("")
async def list_feedback(
    status: str = "",
    category: str = "",
    limit: int = 50,
    offset: int = 0,
):
    """List feedback, newest first. Optional filters."""
    conditions = []
    params = []

    if status and status in VALID_STATUSES:
        conditions.append("status = ?")
        params.append(status)
    if category and category in VALID_CATEGORIES:
        conditions.append("category = ?")
        params.append(category)

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""
    limit = min(limit, 200)

    db = await get_connection()
    try:
        # Count
        row = await db.execute(f"SELECT COUNT(*) FROM feedback {where}", params)
        total = (await row.fetchone())[0]

        # Fetch
        rows = await db.execute(
            f"""SELECT id, created_at, message, category, page_context, status, notes
                FROM feedback {where}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?""",
            params + [limit, offset],
        )
        items = [dict(r) for r in await rows.fetchall()]

        return {"items": items, "total": total, "limit": limit, "offset": offset}
    finally:
        await db.close()


@router.patch("/{feedback_id}")
async def update_feedback(feedback_id: int, body: FeedbackUpdate):
    """Update feedback status or notes (admin)."""
    updates = []
    params = []

    if body.status is not None:
        if body.status not in VALID_STATUSES:
            raise HTTPException(status_code=400, detail=f"Invalid status. Use: {', '.join(VALID_STATUSES)}")
        updates.append("status = ?")
        params.append(body.status)

    if body.notes is not None:
        updates.append("notes = ?")
        params.append(html.escape(body.notes.strip()))

    if not updates:
        raise HTTPException(status_code=400, detail="No fields to update")

    params.append(feedback_id)

    db = await get_connection()
    try:
        result = await db.execute(
            f"UPDATE feedback SET {', '.join(updates)} WHERE id = ?", params
        )
        await db.commit()
        if result.rowcount == 0:
            raise HTTPException(status_code=404, detail="Feedback not found")
        return {"id": feedback_id, "updated": True}
    finally:
        await db.close()
