"""
Column Definition Service — manages the column_definitions.json config.

Provides:
  - get_definitions()      → full definitions dict
  - get_catalog()          → list of entry dicts
  - save_definitions()     → persist changes
  - add_or_update_entry()  → upsert a single entry by label
  - get_token_sets()       → {category: set_of_tokens} for audit service
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List, Optional

_DEFINITIONS_PATH = Path(__file__).resolve().parent.parent / "column_definitions.json"


def get_definitions() -> Dict[str, Any]:
    """Load and return the full column definitions file."""
    if _DEFINITIONS_PATH.exists():
        with _DEFINITIONS_PATH.open("r", encoding="utf-8") as f:
            return json.load(f)
    return {"version": "1.0", "entries": []}


def get_catalog() -> List[Dict[str, Any]]:
    """Return just the entries list."""
    return get_definitions().get("entries", [])


def save_definitions(definitions: Dict[str, Any]) -> None:
    """Persist the full definitions dict to disk."""
    with _DEFINITIONS_PATH.open("w", encoding="utf-8") as f:
        json.dump(definitions, f, indent=2, ensure_ascii=False)


def add_or_update_entry(
    label: str,
    aliases: List[str],
    category: str,
    field_type: str = "currency",
) -> Dict[str, Any]:
    """
    Add a new entry or update an existing one (matched by label, case-insensitive).
    Returns the saved entry.
    """
    defs = get_definitions()
    entries: List[Dict[str, Any]] = defs.get("entries", [])

    label_lower = label.strip().lower()
    new_entry: Dict[str, Any] = {
        "label":    label.strip(),
        "aliases":  [a.strip().lower() for a in aliases if a.strip()],
        "category": category,
        "type":     field_type,
    }

    for i, entry in enumerate(entries):
        if entry.get("label", "").lower() == label_lower:
            entries[i] = new_entry
            defs["entries"] = entries
            save_definitions(defs)
            return new_entry

    entries.append(new_entry)
    defs["entries"] = entries
    save_definitions(defs)
    return new_entry


def get_token_sets() -> Dict[str, set]:
    """
    Return token sets per category derived from all aliases.
    Used by the deterministic audit service to classify mismatch rows.

    Returns:
        {
          "allowances": {"allowance", "transport", ...},
          "deductions": {"ssf", "paye", ...},
          "earnings":   {"salary", "gross", ...},
          "identity":   {"name", "branch", ...},
        }
    """
    token_sets: Dict[str, set] = {
        "allowances": set(),
        "deductions": set(),
        "earnings":   set(),
        "identity":   set(),
    }
    for entry in get_catalog():
        cat = entry.get("category", "")
        if cat not in token_sets:
            continue
        for alias in entry.get("aliases", []):
            # Each individual word in the alias phrase becomes a token
            for tok in str(alias).lower().split():
                if len(tok) >= 2:   # ignore single characters
                    token_sets[cat].add(tok)
    return token_sets
