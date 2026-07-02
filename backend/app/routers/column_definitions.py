"""
Column Definitions router — CRUD for the column_definitions.json config.

Endpoints:
  GET  /api/column-definitions/          → return all definitions
  PUT  /api/column-definitions/          → replace all definitions
  POST /api/column-definitions/entries   → add or update a single entry
"""
from __future__ import annotations

from typing import Any, Dict, List
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.column_definition_service import (
    get_definitions,
    save_definitions,
    add_or_update_entry,
)

router = APIRouter()


class ColumnEntryRequest(BaseModel):
    label: str
    aliases: List[str]
    category: str          # 'allowances' | 'deductions' | 'earnings' | 'identity'
    type: str = "currency" # 'currency' | 'text'


@router.get("/")
async def list_column_definitions():
    """Return all column definitions (entries + version)."""
    return get_definitions()


@router.put("/")
async def replace_column_definitions(body: Dict[str, Any]):
    """Replace the entire column definitions file."""
    if "entries" not in body or not isinstance(body["entries"], list):
        raise HTTPException(status_code=400, detail="Request body must contain an 'entries' list.")
    save_definitions(body)
    return {"ok": True, "entry_count": len(body["entries"])}


@router.post("/entries")
async def add_column_entry(entry: ColumnEntryRequest):
    """
    Add a new entry or update an existing one (matched by label, case-insensitive).
    Useful for persisting manual column classifications across sessions.
    """
    if not entry.label.strip():
        raise HTTPException(status_code=400, detail="label must not be empty.")
    valid_categories = {"allowances", "deductions", "earnings", "identity", "other"}
    if entry.category not in valid_categories:
        raise HTTPException(
            status_code=400,
            detail=f"category must be one of: {sorted(valid_categories)}"
        )
    result = add_or_update_entry(
        label=entry.label,
        aliases=entry.aliases,
        category=entry.category,
        field_type=entry.type,
    )
    return {"ok": True, "entry": result}
