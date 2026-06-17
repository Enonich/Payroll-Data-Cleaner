"""
Template CRUD and inference service.
"""
import uuid
from datetime import datetime
from difflib import SequenceMatcher
from typing import Any, Dict, List, Optional

import pandas as pd

from app.services.db_service import DBService


DEFAULT_TARGET_FIELDS = [
    "employee_id",
    "first_name",
    "last_name",
    "full_name",
    "date_of_birth",
    "gender",
    "department",
    "grade",
    "hire_date",
    "termination_date",
    "national_id",
    "tax_number",
    "basic_salary",
    "allowance_amount",
    "deduction_amount",
    "bank_account",
    "phone_number",
    "email",
]


class ImportTemplateService:
    """Persistent template service backed by SQLite."""

    @staticmethod
    def _now() -> str:
        return datetime.utcnow().isoformat()

    @staticmethod
    def _normalize_template_row(row: Dict[str, Any]) -> Dict[str, Any]:
        definition = DBService.loads_json(row.get("definition_json", "{}"), {})
        return {
            "id": row["id"],
            "name": row["name"],
            "target_system": row["target_system"],
            "import_type": row["import_type"],
            "definition": definition,
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _validate_definition(definition: Dict[str, Any]) -> None:
        columns = definition.get("columns", [])
        if not isinstance(columns, list):
            raise ValueError("definition.columns must be a list")

        for idx, col in enumerate(columns):
            if not isinstance(col, dict):
                raise ValueError(f"definition.columns[{idx}] must be an object")
            target_field = col.get("target_field")
            if not target_field:
                raise ValueError(f"definition.columns[{idx}].target_field is required")

            source_aliases = col.get("source_aliases", [])
            formula = col.get("formula")
            if not formula and not source_aliases:
                raise ValueError(
                    f"definition.columns[{idx}] requires source_aliases for mapped columns"
                )

    @classmethod
    def create_template(cls, payload: Dict[str, Any]) -> Dict[str, Any]:
        template_id = str(uuid.uuid4())
        now = cls._now()

        definition = payload.get("definition") or {}
        cls._validate_definition(definition)

        DBService.execute(
            """
            INSERT INTO templates (id, name, target_system, import_type, definition_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (
                template_id,
                payload["name"],
                payload["target_system"],
                payload.get("import_type", "generic_import"),
                DBService.dumps_json(definition),
                now,
                now,
            ),
        )
        template = cls.get_template(template_id)
        if template is None:
            raise ValueError("Failed to create template")
        return template

    @classmethod
    def list_templates(cls) -> List[Dict[str, Any]]:
        rows = DBService.fetch_all(
            """
            SELECT id, name, target_system, import_type, definition_json, created_at, updated_at
            FROM templates
            ORDER BY updated_at DESC
            """
        )
        return [cls._normalize_template_row(row) for row in rows]

    @classmethod
    def get_template(cls, template_id: str) -> Optional[Dict[str, Any]]:
        row = DBService.fetch_one(
            """
            SELECT id, name, target_system, import_type, definition_json, created_at, updated_at
            FROM templates
            WHERE id = ?
            """,
            (template_id,),
        )
        return cls._normalize_template_row(row) if row else None

    @classmethod
    def update_template(cls, template_id: str, updates: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        current = cls.get_template(template_id)
        if current is None:
            return None

        name = updates.get("name", current["name"])
        target_system = updates.get("target_system", current["target_system"])
        import_type = updates.get("import_type", current["import_type"])
        definition = updates.get("definition", current["definition"])

        cls._validate_definition(definition)

        DBService.execute(
            """
            UPDATE templates
            SET name = ?, target_system = ?, import_type = ?, definition_json = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                name,
                target_system,
                import_type,
                DBService.dumps_json(definition),
                cls._now(),
                template_id,
            ),
        )
        return cls.get_template(template_id)

    @classmethod
    def delete_template(cls, template_id: str) -> bool:
        existing = cls.get_template(template_id)
        if not existing:
            return False
        DBService.execute("DELETE FROM templates WHERE id = ?", (template_id,))
        return True

    @staticmethod
    def infer_template(
        df: pd.DataFrame,
        name: str,
        target_system: str,
        import_type: str,
        known_target_fields: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        fields = known_target_fields or DEFAULT_TARGET_FIELDS

        def score(source: str, target: str) -> float:
            return SequenceMatcher(None, source.lower(), target.lower()).ratio()

        columns = []
        used_targets: set[str] = set()
        for source_col in df.columns.tolist():
            best_target = max(fields, key=lambda t: score(source_col, t)) if fields else source_col
            best_score = score(source_col, best_target) if fields else 1.0
            target_field = best_target
            if target_field in used_targets:
                suffix = 2
                while f"{best_target}_{suffix}" in used_targets:
                    suffix += 1
                target_field = f"{best_target}_{suffix}"
            used_targets.add(target_field)
            columns.append(
                {
                    "target_field": target_field,
                    "source_aliases": [source_col],
                    "required": False,
                    "transforms": [],
                    "value_map": {},
                    "inference_score": round(best_score, 4),
                }
            )

        return {
            "name": name,
            "target_system": target_system,
            "import_type": import_type,
            "definition": {
                "output_format": "csv",
                "required_fields": [],
                "dedup_keys": [],
                "columns": columns,
            },
        }
