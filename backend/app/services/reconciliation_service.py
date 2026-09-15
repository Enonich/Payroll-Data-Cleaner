"""
Persistent payroll reconciliation runs, issue review, audit, and HR exports.
"""
from __future__ import annotations

import math
import re
import uuid
from datetime import datetime
from typing import Any, Dict, List, Optional

import numpy as np
import pandas as pd

from app.services.db_service import DBService
from app.services.file_service import FileService


VALID_ISSUE_STATUSES = {"open", "approved", "rejected", "ignored"}
VALID_ACTIONS = {"approve", "reject", "ignore", "reopen"}


class ReconciliationService:
    """Create and manage reviewable reconciliation issues from comparison output."""

    @staticmethod
    def _now() -> str:
        return datetime.utcnow().isoformat()

    @staticmethod
    def _string_value(value: Any) -> Optional[str]:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        return str(value)

    @classmethod
    def _json_safe_value(cls, value: Any) -> Any:
        if value is None:
            return None
        if isinstance(value, float):
            return None if (math.isnan(value) or math.isinf(value)) else value
        if isinstance(value, np.generic):
            val = value.item()
            if isinstance(val, float) and (math.isnan(val) or math.isinf(val)):
                return None
            return val
        if isinstance(value, pd.Timestamp):
            return value.isoformat()
        if hasattr(value, "isoformat"):
            try:
                return value.isoformat()
            except (TypeError, ValueError):
                pass
        if isinstance(value, dict):
            return {str(k): cls._json_safe_value(v) for k, v in value.items()}
        if isinstance(value, (list, tuple)):
            return [cls._json_safe_value(v) for v in value]
        try:
            if pd.isna(value):
                return None
        except Exception:
            pass
        return value

    @classmethod
    def _json_safe_row(cls, row: Dict[str, Any]) -> Dict[str, Any]:
        return {str(k): cls._json_safe_value(v) for k, v in row.items()}

    @staticmethod
    def _find_id_column(df: Optional[pd.DataFrame]) -> Optional[str]:
        if df is None or len(df.columns) == 0:
            return None

        preferred = [
            "staff_id", "staff id", "staffid",
            "employee_id", "employee id", "emp_id", "emp id", "id",
        ]
        normalized = {str(col).strip().lower().replace("_", " "): col for col in df.columns}

        for candidate in preferred:
            if candidate in normalized:
                return normalized[candidate]

        for col in df.columns:
            name = str(col).strip().lower().replace("_", " ")
            if "id" in name:
                return col
        return None

    @classmethod
    def _count_missing_ids(cls, file_id: str) -> int:
        df = FileService.get_dataframe(file_id)
        id_column = cls._find_id_column(df)
        if df is None or id_column is None:
            return 0

        series = df[id_column]
        missing_mask = series.isna() | (series.astype(str).str.strip() == "")
        return int(missing_mask.sum())

    @staticmethod
    def _parse_run(row: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": row["id"],
            "source_file1_id": row["source_file1_id"],
            "source_file2_id": row["source_file2_id"],
            "file1_label": row["file1_label"],
            "file2_label": row["file2_label"],
            "summary": DBService.loads_json(row.get("summary_json", "{}"), {}),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @staticmethod
    def _parse_issue(row: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": row["id"],
            "run_id": row["run_id"],
            "issue_type": row["issue_type"],
            "status": row["status"],
            "employee_id": row.get("employee_id"),
            "employee_name": row.get("employee_name"),
            "field": row.get("field"),
            "old_value": row.get("old_value"),
            "new_value": row.get("new_value"),
            "difference": row.get("difference"),
            "confidence": row["confidence"],
            "suggested_action": row["suggested_action"],
            "explanation": row["explanation"],
            "source": DBService.loads_json(row.get("source_json", "{}"), {}),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @classmethod
    def _classify_field_issue(cls, row: Dict[str, Any], employee_fields: Dict[str, set], file1_label: str = "File 1", file2_label: str = "File 2") -> Dict[str, Any]:
        field = str(row.get("field") or "").strip()
        field_key = field.lower()
        employee_id = cls._string_value(row.get("employee_id"))
        difference = row.get("difference")
        try:
            numeric_difference = float(difference) if difference is not None else None
        except (TypeError, ValueError):
            numeric_difference = None

        issue_type = "field_mismatch"
        suggested_action = f"Review field change between {file1_label} and {file2_label}"
        explanation = f"{field or 'Field'} differs between {file1_label} and {file2_label}."
        category = str(row.get("category") or "").lower()

        if any(token in field_key for token in ["rank", "grade", "level"]):
            issue_type = "rank_change"
            suggested_action = f"Approve {file1_label} rank update if promotion/grade change is valid"
            explanation = f"Rank changed from {row.get('file1_value')} (in {file1_label}) to {row.get('file2_value')} (in {file2_label})."
        elif any(token in field_key for token in ["branch", "location", "office"]):
            issue_type = "branch_change"
            suggested_action = f"Approve {file1_label} branch update if transfer is valid"
            explanation = f"Branch changed from {row.get('file1_value')} (in {file1_label}) to {row.get('file2_value')} (in {file2_label})."
        elif any(token in field_key for token in ["basic salary", "basic pay", "monthly salary", "monthly basic", "basic"]):
            issue_type = "basic_salary_change"
            suggested_action = f"Approve {file1_label} basic salary update if authorized"
            if numeric_difference is not None:
                explanation = f"{field} changed by {numeric_difference:,.2f}."
            employee_known_fields = employee_fields.get(employee_id or "", set())
            if employee_known_fields.intersection({"rank_change", "grade_change"}):
                explanation += f" Possible reason: rank or grade changed in {file1_label}/{file2_label}."
        elif any(token in field_key for token in ["annual salary", "annual pay", "yearly salary", "yearly pay", "annual", "yearly"]):
            issue_type = "annual_salary_change"
            suggested_action = f"Approve {file1_label} annual salary update if authorized"
            if numeric_difference is not None:
                explanation = f"{field} changed by {numeric_difference:,.2f}."
        elif any(token in field_key for token in ["take home", "takehome", "net pay", "net salary"]):
            issue_type = "take_home_change"
            suggested_action = f"Review take home pay change in {file2_label}"
            if numeric_difference is not None:
                explanation = f"{field} changed by {numeric_difference:,.2f}."
        elif category == "statutory_deductions":
            issue_type = "statutory_deduction_change"
            suggested_action = f"Review statutory deduction change in {file2_label}"
            if numeric_difference is not None:
                explanation = f"{field} changed by {numeric_difference:,.2f}."
        elif category == "non_statutory_deductions":
            issue_type = "non_statutory_deduction_change"
            suggested_action = f"Review non-statutory deduction change in {file2_label}"
            if numeric_difference is not None:
                explanation = f"{field} changed by {numeric_difference:,.2f}."
        elif any(token in field_key for token in ["allowance", "ssf", "pf"]):
            issue_type = "allowance_change"
            suggested_action = f"Review allowance change in {file2_label}"
            if numeric_difference is not None:
                explanation = f"{field} changed by {numeric_difference:,.2f}."
        elif any(token in field_key for token in ["deduction", "tax", "levy"]):
            issue_type = "deduction_change"
            suggested_action = f"Review deduction change in {file2_label}"
            if numeric_difference is not None:
                explanation = f"{field} changed by {numeric_difference:,.2f}."
        elif any(token in field_key for token in ["salary", "gross", "pay"]):
            issue_type = "salary_change"
            suggested_action = f"Approve {file1_label} salary update if authorized"
            if numeric_difference is not None:
                explanation = f"{field} changed by {numeric_difference:,.2f}."
            employee_known_fields = employee_fields.get(employee_id or "", set())
            if employee_known_fields.intersection({"rank_change", "grade_change"}):
                explanation += f" Possible reason: rank or grade changed in {file1_label}/{file2_label}."

        return {
            "issue_type": issue_type,
            "suggested_action": suggested_action,
            "explanation": explanation,
            "difference": numeric_difference,
        }

    @classmethod
    def _issue_rows_from_result(
        cls,
        result: Dict[str, Any],
        file1_label: str = "File 1",
        file2_label: str = "File 2",
    ) -> List[Dict[str, Any]]:
        mismatch_rows = result["mismatches_df"].to_dict("records") if len(result["mismatches_df"]) else []
        employee_fields: Dict[str, set] = {}
        for row in mismatch_rows:
            employee_id = cls._string_value(row.get("employee_id")) or ""
            field = str(row.get("field") or "").lower()
            if any(token in field for token in ["rank", "grade", "level"]):
                employee_fields.setdefault(employee_id, set()).add("rank_change")
            if "grade" in field:
                employee_fields.setdefault(employee_id, set()).add("grade_change")

        issues: List[Dict[str, Any]] = []
        for row in mismatch_rows:
            classified = cls._classify_field_issue(row, employee_fields, file1_label, file2_label)
            employee_name = row.get("file2_name") or row.get("file1_name")
            issues.append({
                "issue_type": classified["issue_type"],
                "employee_id": cls._string_value(row.get("employee_id")),
                "employee_name": cls._string_value(employee_name),
                "field": cls._string_value(row.get("field")),
                "old_value": cls._string_value(row.get("file1_value")),
                "new_value": cls._string_value(row.get("file2_value")),
                "difference": classified["difference"],
                "confidence": 1.0,
                "suggested_action": classified["suggested_action"],
                "explanation": classified["explanation"],
                "source": cls._json_safe_row(row),
            })

        for row in result["only_in_file1_df"].to_dict("records") if len(result["only_in_file1_df"]) else []:
            employee_id = cls._string_value(next((row.get(k) for k in row.keys() if "id" in str(k).lower()), None))
            employee_name = cls._string_value(next((row.get(k) for k in row.keys() if "name" in str(k).lower()), None))
            issues.append({
                "issue_type": "potential_resignation",
                "employee_id": employee_id,
                "employee_name": employee_name,
                "field": "Employee Status",
                "old_value": f"Present in {file1_label}",
                "new_value": f"Missing from {file2_label}",
                "difference": None,
                "confidence": 0.9,
                "suggested_action": f"Generate {file1_label} offboarding/resignation review",
                "explanation": f"Employee appears in {file1_label} but is missing from {file2_label}.",
                "source": cls._json_safe_row(row),
            })

        for row in result["only_in_file2_df"].to_dict("records") if len(result["only_in_file2_df"]) else []:
            employee_id = cls._string_value(next((row.get(k) for k in row.keys() if "id" in str(k).lower()), None))
            employee_name = cls._string_value(next((row.get(k) for k in row.keys() if "name" in str(k).lower()), None))
            issues.append({
                "issue_type": "potential_new_hire",
                "employee_id": employee_id,
                "employee_name": employee_name,
                "field": "Employee Status",
                "old_value": f"Missing from {file1_label}",
                "new_value": f"Present in {file2_label}",
                "difference": None,
                "confidence": 0.9,
                "suggested_action": f"Generate {file2_label} onboarding/import review",
                "explanation": f"Employee appears in {file2_label} but is missing from {file1_label}.",
                "source": cls._json_safe_row(row),
            })

        return issues

    @classmethod
    def create_run_from_employee_data_result(
        cls,
        file1_id: str,
        file2_id: str,
        file1_label: str,
        file2_label: str,
        result: Dict[str, Any],
    ) -> Dict[str, Any]:
        run_id = str(uuid.uuid4())
        now = cls._now()
        summary = {
            "total_file1": result["total_file1"],
            "total_file2": result["total_file2"],
            "matched": result["matched"],
            "only_in_file1": result["only_in_file1"],
            "only_in_file2": result["only_in_file2"],
            "employees_with_differences": result["employees_with_differences"],
            "field_differences": result["field_differences"],
        }

        DBService.execute(
            """
            INSERT INTO reconciliation_runs (
                id, source_file1_id, source_file2_id, file1_label, file2_label,
                summary_json, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (run_id, file1_id, file2_id, file1_label, file2_label, DBService.dumps_json(summary), now, now),
        )

        issue_rows = cls._issue_rows_from_result(result, file1_label, file2_label)
        for issue in issue_rows:
            issue_id = str(uuid.uuid4())
            DBService.execute(
                """
                INSERT INTO reconciliation_issues (
                    id, run_id, issue_type, status, employee_id, employee_name, field,
                    old_value, new_value, difference, confidence, suggested_action,
                    explanation, source_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    issue_id,
                    run_id,
                    issue["issue_type"],
                    "open",
                    issue["employee_id"],
                    issue["employee_name"],
                    issue["field"],
                    issue["old_value"],
                    issue["new_value"],
                    issue["difference"],
                    issue["confidence"],
                    issue["suggested_action"],
                    issue["explanation"],
                    DBService.dumps_json(issue["source"]),
                    now,
                    now,
                ),
            )

        cls._record_audit(run_id, None, "created", "system", f"Created {len(issue_rows)} reconciliation issues", None, None)
        return cls.get_run(run_id)

    @classmethod
    def _record_audit(
        cls,
        run_id: str,
        issue_id: Optional[str],
        action: str,
        actor: str,
        note: Optional[str],
        before_status: Optional[str],
        after_status: Optional[str],
    ) -> None:
        DBService.execute(
            """
            INSERT INTO reconciliation_audit (
                id, run_id, issue_id, action, actor, note, before_status, after_status, created_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (str(uuid.uuid4()), run_id, issue_id, action, actor, note, before_status, after_status, cls._now()),
        )

    @classmethod
    def list_runs(cls) -> List[Dict[str, Any]]:
        rows = DBService.fetch_all("SELECT * FROM reconciliation_runs ORDER BY updated_at DESC")
        return [cls._parse_run(row) for row in rows]

    @classmethod
    def get_run(cls, run_id: str) -> Dict[str, Any]:
        run_row = DBService.fetch_one("SELECT * FROM reconciliation_runs WHERE id = ?", (run_id,))
        if not run_row:
            raise ValueError("Reconciliation run not found")

        issue_rows = DBService.fetch_all(
            """
            SELECT * FROM reconciliation_issues
            WHERE run_id = ?
            ORDER BY
                CASE status WHEN 'open' THEN 0 WHEN 'approved' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
                issue_type,
                employee_id
            """,
            (run_id,),
        )
        audit_rows = DBService.fetch_all(
            "SELECT * FROM reconciliation_audit WHERE run_id = ? ORDER BY created_at DESC LIMIT 50",
            (run_id,),
        )
        run = cls._parse_run(run_row)
        issues = [cls._parse_issue(row) for row in issue_rows]
        status_counts: Dict[str, int] = {}
        type_counts: Dict[str, int] = {}
        for issue in issues:
            status_counts[issue["status"]] = status_counts.get(issue["status"], 0) + 1
            type_counts[issue["issue_type"]] = type_counts.get(issue["issue_type"], 0) + 1

        run["issues"] = issues
        run["status_counts"] = status_counts
        run["type_counts"] = type_counts
        run["audit"] = audit_rows
        return run

    @classmethod
    def get_employee_bundle(cls, run_id: str, employee_id: str) -> Dict[str, Any]:
        """Pull an employee's full row(s) from both source files plus their flagged issues."""
        run = cls.get_run(run_id)
        target = str(employee_id).strip().lower()

        df1 = FileService.get_dataframe(run["source_file1_id"])
        df2 = FileService.get_dataframe(run["source_file2_id"])
        id_col1 = cls._find_id_column(df1)
        id_col2 = cls._find_id_column(df2)

        def _rows_for(df: Optional[pd.DataFrame], id_col: Optional[str]) -> List[Dict[str, Any]]:
            if df is None or id_col is None:
                return []
            mask = df[id_col].astype(str).str.strip().str.lower() == target
            return [cls._json_safe_row(row) for row in df[mask].to_dict("records")]

        file1_rows = _rows_for(df1, id_col1)
        file2_rows = _rows_for(df2, id_col2)
        issues = [
            issue for issue in run["issues"]
            if str(issue.get("employee_id") or "").strip().lower() == target
        ]

        if not file1_rows and not file2_rows and not issues:
            raise ValueError(f"No records found for employee '{employee_id}' in this run")

        employee_name = next((i["employee_name"] for i in issues if i.get("employee_name")), None)
        if not employee_name:
            for row in file1_rows + file2_rows:
                for key, value in row.items():
                    if "name" in str(key).lower() and value:
                        employee_name = value
                        break
                if employee_name:
                    break

        # Columns that actually differ between the two files for this employee -- these are
        # the only fields worth sending to the AI, since identical fields can't explain a difference.
        file1_diff_columns: set = set()
        file2_diff_columns: set = set()
        for issue in issues:
            source = issue.get("source") or {}
            col1 = source.get("file1_column")
            col2 = source.get("file2_column")
            if col1:
                file1_diff_columns.add(col1)
            if col2:
                file2_diff_columns.add(col2)
            if not col1 and not col2 and issue.get("field"):
                file1_diff_columns.add(issue["field"])
                file2_diff_columns.add(issue["field"])

        return {
            "run_id": run_id,
            "employee_id": employee_id,
            "employee_name": employee_name,
            "file1_label": run["file1_label"],
            "file2_label": run["file2_label"],
            "file1_rows": file1_rows,
            "file2_rows": file2_rows,
            "file1_diff_columns": sorted(file1_diff_columns),
            "file2_diff_columns": sorted(file2_diff_columns),
            "issues": issues,
        }

    @classmethod
    def apply_issue_action(
        cls,
        run_id: str,
        issue_id: str,
        action: str,
        actor: str = "Payroll Officer",
        note: Optional[str] = None,
    ) -> Dict[str, Any]:
        if action not in VALID_ACTIONS:
            raise ValueError(f"Invalid action '{action}'")

        row = DBService.fetch_one(
            "SELECT * FROM reconciliation_issues WHERE id = ? AND run_id = ?",
            (issue_id, run_id),
        )
        if not row:
            raise ValueError("Reconciliation issue not found")

        before_status = row["status"]
        after_status = {
            "approve": "approved",
            "reject": "rejected",
            "ignore": "ignored",
            "reopen": "open",
        }[action]

        DBService.execute(
            """
            UPDATE reconciliation_issues
            SET status = ?, updated_at = ?
            WHERE id = ? AND run_id = ?
            """,
            (after_status, cls._now(), issue_id, run_id),
        )
        DBService.execute(
            "UPDATE reconciliation_runs SET updated_at = ? WHERE id = ?",
            (cls._now(), run_id),
        )
        cls._record_audit(run_id, issue_id, action, actor, note, before_status, after_status)
        return cls.get_run(run_id)

    @classmethod
    def apply_bulk_issue_action(
        cls,
        run_id: str,
        issue_ids: List[str],
        action: str,
        actor: str = "Payroll Officer",
        note: Optional[str] = None,
    ) -> Dict[str, Any]:
        if action not in VALID_ACTIONS:
            raise ValueError(f"Invalid action '{action}'")

        if not issue_ids:
            return cls.get_run(run_id)

        after_status = {
            "approve": "approved",
            "reject": "rejected",
            "ignore": "ignored",
            "reopen": "open",
        }[action]

        placeholders = ",".join("?" for _ in issue_ids)
        rows = DBService.fetch_all(
            f"SELECT id, status FROM reconciliation_issues WHERE id IN ({placeholders}) AND run_id = ?",
            (*issue_ids, run_id),
        )

        now = cls._now()
        for row in rows:
            before_status = row["status"]
            issue_id = row["id"]
            
            DBService.execute(
                """
                UPDATE reconciliation_issues
                SET status = ?, updated_at = ?
                WHERE id = ? AND run_id = ?
                """,
                (after_status, now, issue_id, run_id),
            )
            cls._record_audit(run_id, issue_id, action, actor, note, before_status, after_status)

        DBService.execute(
            "UPDATE reconciliation_runs SET updated_at = ? WHERE id = ?",
            (now, run_id),
        )
        return cls.get_run(run_id)

    @classmethod
    def export_approved_updates(cls, run_id: str) -> Dict[str, Any]:
        run = cls.get_run(run_id)
        approved = [issue for issue in run["issues"] if issue["status"] == "approved"]

        update_rows = []
        new_hire_rows = []
        resignation_rows = []
        for issue in approved:
            if issue["issue_type"] == "potential_new_hire":
                row = issue["source"].copy()
                row["Suggested Action"] = "Onboard employee"
                new_hire_rows.append(row)
            elif issue["issue_type"] == "potential_resignation":
                row = issue["source"].copy()
                row["Suggested Action"] = "Review offboarding"
                resignation_rows.append(row)
            else:
                update_rows.append({
                    "Employee": issue["employee_id"],
                    "Employee Name": issue["employee_name"],
                    "Field": issue["field"],
                    "Old Value": issue["old_value"],
                    "New Value": issue["new_value"],
                    "Issue Type": issue["issue_type"],
                    "Explanation": issue["explanation"],
                })

        files: Dict[str, Dict[str, Any]] = {}
        if update_rows:
            df = pd.DataFrame(update_rows)
            file_id = FileService.create_new_file(df, "hr_update_file.csv")
            files["hr_updates"] = {"file_id": file_id, "records": len(df)}
        if new_hire_rows:
            df = pd.DataFrame(new_hire_rows)
            file_id = FileService.create_new_file(df, "new_employee_import_file.csv")
            files["new_employees"] = {"file_id": file_id, "records": len(df)}
        if resignation_rows:
            df = pd.DataFrame(resignation_rows)
            file_id = FileService.create_new_file(df, "resignation_review_file.csv")
            files["resignations"] = {"file_id": file_id, "records": len(df)}

        cls._record_audit(run_id, None, "exported", "system", f"Generated {len(files)} approved export file(s)", None, None)
        return {"run_id": run_id, "approved_issues": len(approved), "files": files}

    @classmethod
    def export_role_differences(cls, run_id: str) -> Dict[str, Any]:
        run = cls.get_run(run_id)
        role_issues = [
            issue for issue in run.get("issues", [])
            if issue.get("issue_type") == "rank_change"
        ]

        rows = []
        for issue in role_issues:
            rows.append({
                "Employee ID": issue.get("employee_id"),
                "Employee Name": issue.get("employee_name"),
                "Role Field": issue.get("field"),
                f"Role in {run.get('file1_label') or 'File 1'}": issue.get("old_value"),
                f"Role in {run.get('file2_label') or 'File 2'}": issue.get("new_value"),
                "Status": issue.get("status"),
                "Suggested Action": issue.get("suggested_action"),
                "Explanation": issue.get("explanation"),
            })

        files: Dict[str, Dict[str, Any]] = {}
        if rows:
            df = pd.DataFrame(rows)
            file_id = FileService.create_new_file(df, f"{run_id}_role_differences.csv")
            files["role_differences"] = {"file_id": file_id, "records": len(df)}

        cls._record_audit(
            run_id,
            None,
            "role_differences_exported",
            "system",
            f"Generated {len(files)} role difference export file(s)",
            None,
            None,
        )
        return {"run_id": run_id, "role_differences": len(role_issues), "files": files}

    @classmethod
    def export_investigated_differences(cls, run_id: str, employee_ids: List[str]) -> Dict[str, Any]:
        run = cls.get_run(run_id)
        targets = {
            str(employee_id).strip().lower()
            for employee_id in employee_ids
            if str(employee_id).strip()
        }
        if not targets:
            raise ValueError("Select at least one candidate to export")

        issues = [
            issue for issue in run.get("issues", [])
            if str(issue.get("employee_id") or "").strip().lower() in targets
        ]

        file1_label = run.get("file1_label") or "File 1"
        file2_label = run.get("file2_label") or "File 2"
        source_info = FileService.get_file_info(run.get("source_file1_id")) or {}
        payroll_info = FileService.get_file_info(run.get("source_file2_id")) or {}
        source_filename = source_info.get("filename") or file1_label
        payroll_filename = payroll_info.get("filename") or file2_label

        def is_blank(value: Any) -> bool:
            if value is None:
                return True
            try:
                if pd.isna(value):
                    return True
            except (TypeError, ValueError):
                pass
            return str(value).strip() == ""

        def number_value(value: Any) -> Optional[float]:
            if is_blank(value) or isinstance(value, bool):
                return None
            text = str(value).strip().replace(",", "")
            if text.startswith("(") and text.endswith(")"):
                text = f"-{text[1:-1]}"
            text = re.sub(r"^[^0-9+-.]+|[^0-9.]+$", "", text)
            try:
                return float(text)
            except (TypeError, ValueError):
                return None

        def difference_type(issue: Dict[str, Any], source_value: Any, payroll_value: Any) -> str:
            issue_type = str(issue.get("issue_type") or "").lower()
            field = str(issue.get("field") or "").lower()
            if issue_type == "potential_new_hire" or (is_blank(source_value) and not is_blank(payroll_value)):
                return "missing_in_source"
            if issue_type == "potential_resignation" or (not is_blank(source_value) and is_blank(payroll_value)):
                return "missing_in_payroll"
            if "name" in field:
                return "name_mismatch"
            if any(token in field for token in ("account", "bank", "iban")):
                return "account_mismatch"
            if any(token in field for token in ("take home", "takehome", "net pay", "net salary")):
                return "take_home_difference"
            if "allowance" in field or issue_type == "allowance_change":
                return "allowance_difference"
            if any(token in field for token in ("deduction", "tax", "levy")) or "deduction" in issue_type:
                return "deduction_difference"
            if issue.get("difference") is not None or (
                number_value(source_value) is not None and number_value(payroll_value) is not None
            ):
                return "amount_difference"
            return "field_mismatch"

        detail_rows: List[Dict[str, Any]] = []
        for issue in issues:
            source = issue.get("source") or {}
            source_value = source.get("file1_value", issue.get("old_value"))
            payroll_value = source.get("file2_value", issue.get("new_value"))
            numeric_difference = issue.get("difference")
            if numeric_difference is None:
                source_number = number_value(source_value)
                payroll_number = number_value(payroll_value)
                if source_number is not None and payroll_number is not None:
                    numeric_difference = payroll_number - source_number
            classified_type = difference_type(issue, source_value, payroll_value)
            financial_impact = numeric_difference if classified_type in {
                "amount_difference", "allowance_difference", "deduction_difference", "take_home_difference"
            } else None
            detail_rows.append({
                "employee_id": issue.get("employee_id"),
                "employee_name": issue.get("employee_name") or source.get("file2_name") or source.get("file1_name"),
                "difference_type": classified_type,
                "field_name": issue.get("field") or source.get("file1_column") or source.get("file2_column") or "Employee Status",
                "source_value": source_value,
                "payroll_value": payroll_value,
                "numeric_difference": numeric_difference,
                "source_column": source.get("file1_column"),
                "payroll_column": source.get("file2_column"),
                "source_file": source_filename,
                "payroll_file": payroll_filename,
                "financial_impact": financial_impact,
                "status": issue.get("status"),
                "investigation_note": issue.get("explanation"),
            })

        summary_rows: List[Dict[str, Any]] = []
        for target in sorted(targets):
            employee_details = [
                row for row in detail_rows
                if str(row.get("employee_id") or "").strip().lower() == target
            ]
            if not employee_details:
                continue
            statuses = sorted({str(row["status"]) for row in employee_details if row.get("status")})
            summary_rows.append({
                "employee_id": employee_details[0].get("employee_id"),
                "employee_name": employee_details[0].get("employee_name"),
                "difference_count": len(employee_details),
                "total_financial_difference": sum(
                    float(row["financial_impact"])
                    for row in employee_details
                    if row.get("financial_impact") is not None
                ),
                "allowance_differences": sum(row["difference_type"] == "allowance_difference" for row in employee_details),
                "deduction_differences": sum(row["difference_type"] == "deduction_difference" for row in employee_details),
                "field_mismatches": sum(row["difference_type"] in {"field_mismatch", "name_mismatch", "account_mismatch"} for row in employee_details),
                "take_home_difference": sum(
                    float(row["numeric_difference"])
                    for row in employee_details
                    if row["difference_type"] == "take_home_difference" and row.get("numeric_difference") is not None
                ),
                "status": statuses[0] if len(statuses) == 1 else ", ".join(statuses),
            })

        comparison_rows: List[Dict[str, Any]] = []
        for target in sorted(targets):
            bundle = cls.get_employee_bundle(run_id, target)
            source_row = bundle.get("file1_rows", [{}])[0] if bundle.get("file1_rows") else {}
            payroll_row = bundle.get("file2_rows", [{}])[0] if bundle.get("file2_rows") else {}
            source_id_column = cls._find_id_column(pd.DataFrame([source_row])) if source_row else None
            payroll_id_column = cls._find_id_column(pd.DataFrame([payroll_row])) if payroll_row else None

            def name_column(row: Dict[str, Any]) -> Optional[str]:
                return next((key for key in row if "name" in str(key).lower()), None)

            excluded_source = {column for column in (source_id_column, name_column(source_row)) if column}
            excluded_payroll = {column for column in (payroll_id_column, name_column(payroll_row)) if column}
            used_source: set = set()
            used_payroll: set = set()
            field_pairs: List[tuple] = []

            for issue in bundle.get("issues", []):
                issue_source = issue.get("source") or {}
                source_column = issue_source.get("file1_column")
                payroll_column = issue_source.get("file2_column")
                if not source_column and not payroll_column:
                    continue
                pair = (issue.get("field") or source_column or payroll_column, source_column, payroll_column)
                if pair not in field_pairs:
                    field_pairs.append(pair)
                    if source_column:
                        used_source.add(source_column)
                    if payroll_column:
                        used_payroll.add(payroll_column)

            normalized_payroll = {
                re.sub(r"[^a-z0-9]", "", str(column).lower()): column
                for column in payroll_row
                if column not in excluded_payroll and column not in used_payroll
            }
            for source_column in source_row:
                if source_column in excluded_source or source_column in used_source:
                    continue
                normalized = re.sub(r"[^a-z0-9]", "", str(source_column).lower())
                payroll_column = normalized_payroll.get(normalized)
                field_pairs.append((source_column, source_column, payroll_column))
                used_source.add(source_column)
                if payroll_column:
                    used_payroll.add(payroll_column)
            for payroll_column in payroll_row:
                if payroll_column not in excluded_payroll and payroll_column not in used_payroll:
                    field_pairs.append((payroll_column, None, payroll_column))

            for field_name, source_column, payroll_column in field_pairs:
                source_value = source_row.get(source_column) if source_column else None
                payroll_value = payroll_row.get(payroll_column) if payroll_column else None
                source_number = number_value(source_value)
                payroll_number = number_value(payroll_value)
                numeric_difference = (
                    payroll_number - source_number
                    if source_number is not None and payroll_number is not None
                    else None
                )
                values_match = (
                    abs(numeric_difference) < 0.0000001
                    if numeric_difference is not None
                    else str(source_value or "").strip().casefold() == str(payroll_value or "").strip().casefold()
                )
                comparison_rows.append({
                    "employee_id": bundle.get("employee_id"),
                    "employee_name": bundle.get("employee_name"),
                    "field_name": field_name,
                    "source_value": source_value,
                    "payroll_value": payroll_value,
                    "difference": numeric_difference,
                    "match": "Yes" if values_match else "No",
                })

        period_candidates = [payroll_filename, file2_label, source_filename, file1_label]
        month_names = {
            "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
            "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
            "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
            "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
        }
        period = None
        for candidate in period_candidates:
            text = str(candidate or "").lower()
            numeric_match = re.search(r"(20\d{2})[-_. ](0?[1-9]|1[0-2])", text)
            if numeric_match:
                period = f"{numeric_match.group(1)}-{int(numeric_match.group(2)):02d}"
                break
            month_match = re.search(
                r"(?<![a-z])(" + "|".join(month_names) + r")(?![a-z])[-_ ]*(20\d{2})"
                r"|(20\d{2})[-_ ]*(?<![a-z])(" + "|".join(month_names) + r")(?![a-z])",
                text,
            )
            if month_match:
                month_name = month_match.group(1) or month_match.group(4)
                year = month_match.group(2) or month_match.group(3)
                period = f"{year}-{month_names[month_name]:02d}"
                break
        if not period:
            period = str(run.get("created_at") or cls._now())[:7]

        exports = {
            "payroll_difference_summary": summary_rows,
            "payroll_difference_details": detail_rows,
            "payroll_employee_comparison": comparison_rows,
        }
        files: Dict[str, Dict[str, Any]] = {}
        for export_name, rows in exports.items():
            if not rows:
                continue
            dataframe = pd.DataFrame(rows)
            filename = f"{export_name}_{period}.csv"
            file_id = FileService.create_new_file(dataframe, filename)
            files[export_name] = {"file_id": file_id, "records": len(dataframe), "filename": filename}

        cls._record_audit(
            run_id,
            None,
            "investigated_differences_exported",
            "system",
            f"Generated {len(files)} payroll investigation exports for {len(targets)} employee(s)",
            None,
            None,
        )
        return {
            "run_id": run_id,
            "candidates": len(targets),
            "differences": len(issues),
            "files": files,
        }

    @classmethod
    def get_dashboard_summary(cls) -> Dict[str, Any]:
        runs = cls.list_runs()
        latest = runs[0] if runs else None

        if not latest:
            return {
                "has_data": False,
                "latest_run": None,
                "metrics": {
                    "total_records": 0,
                    "matched_employees": 0,
                    "new_employees": 0,
                    "potential_resignations": 0,
                    "missing_ids": 0,
                    "salary_changes": 0,
                    "rank_changes": 0,
                    "calculation_errors": 0,
                    "manual_reviews_needed": 0,
                },
                "recent_runs": [],
            }

        run = cls.get_run(latest["id"])
        type_counts = run.get("type_counts", {})
        status_counts = run.get("status_counts", {})
        summary = run.get("summary", {})

        metrics = {
            "total_records": int(summary.get("total_file2", summary.get("total_file1", 0)) or 0),
            "matched_employees": int(summary.get("matched", 0) or 0),
            "new_employees": int(type_counts.get("potential_new_hire", 0) or 0),
            "potential_resignations": int(type_counts.get("potential_resignation", 0) or 0),
            "missing_ids": cls._count_missing_ids(run["source_file2_id"]),
            "salary_changes": int(type_counts.get("salary_change", 0) or 0),
            "rank_changes": int(type_counts.get("rank_change", 0) or 0),
            "calculation_errors": int(type_counts.get("calculation_error", 0) or 0),
            "manual_reviews_needed": int(status_counts.get("open", 0) or 0),
        }

        recent_runs = []
        for item in runs[:8]:
            recent_runs.append({
                "id": item["id"],
                "file1_label": item["file1_label"],
                "file2_label": item["file2_label"],
                "summary": item.get("summary", {}),
                "updated_at": item["updated_at"],
            })

        return {
            "has_data": True,
            "latest_run": {
                "id": run["id"],
                "file1_label": run["file1_label"],
                "file2_label": run["file2_label"],
                "created_at": run["created_at"],
                "updated_at": run["updated_at"],
            },
            "metrics": metrics,
            "status_counts": status_counts,
            "type_counts": type_counts,
            "recent_runs": recent_runs,
        }

    @classmethod
    def generate_run_report(cls, run_id: str) -> Dict[str, Any]:
        run = cls.get_run(run_id)
        issues = run.get("issues", [])

        issues_sorted = sorted(
            issues,
            key=lambda issue: abs(float(issue.get("difference") or 0.0)),
            reverse=True,
        )

        high_impact = []
        for issue in issues_sorted[:15]:
            high_impact.append({
                "issue_id": issue["id"],
                "issue_type": issue["issue_type"],
                "employee_id": issue.get("employee_id"),
                "employee_name": issue.get("employee_name"),
                "field": issue.get("field"),
                "old_value": issue.get("old_value"),
                "new_value": issue.get("new_value"),
                "difference": issue.get("difference"),
                "status": issue.get("status"),
                "explanation": issue.get("explanation"),
            })

        totals = {
            "issues": len(issues),
            "open": int(run.get("status_counts", {}).get("open", 0) or 0),
            "approved": int(run.get("status_counts", {}).get("approved", 0) or 0),
            "rejected": int(run.get("status_counts", {}).get("rejected", 0) or 0),
            "ignored": int(run.get("status_counts", {}).get("ignored", 0) or 0),
        }

        return {
            "run": {
                "id": run["id"],
                "file1_label": run["file1_label"],
                "file2_label": run["file2_label"],
                "created_at": run["created_at"],
                "updated_at": run["updated_at"],
            },
            "summary": run.get("summary", {}),
            "status_counts": run.get("status_counts", {}),
            "type_counts": run.get("type_counts", {}),
            "totals": totals,
            "high_impact_issues": high_impact,
            "audit": run.get("audit", []),
        }

    @classmethod
    def export_run_report(cls, run_id: str) -> Dict[str, Any]:
        report = cls.generate_run_report(run_id)
        run = cls.get_run(run_id)

        issue_rows = []
        for issue in run.get("issues", []):
            issue_rows.append({
                "Issue ID": issue["id"],
                "Issue Type": issue.get("issue_type"),
                "Status": issue.get("status"),
                "Employee ID": issue.get("employee_id"),
                "Employee Name": issue.get("employee_name"),
                "Field": issue.get("field"),
                "Old Value": issue.get("old_value"),
                "New Value": issue.get("new_value"),
                "Difference": issue.get("difference"),
                "Confidence": issue.get("confidence"),
                "Suggested Action": issue.get("suggested_action"),
                "Explanation": issue.get("explanation"),
                "Created At": issue.get("created_at"),
                "Updated At": issue.get("updated_at"),
            })

        audit_rows = []
        for row in run.get("audit", []):
            audit_rows.append({
                "Audit ID": row.get("id"),
                "Issue ID": row.get("issue_id"),
                "Action": row.get("action"),
                "Actor": row.get("actor"),
                "Note": row.get("note"),
                "Before Status": row.get("before_status"),
                "After Status": row.get("after_status"),
                "Created At": row.get("created_at"),
            })

        summary_rows = []
        for key, value in report.get("totals", {}).items():
            summary_rows.append({"Metric": key, "Value": value})
        for key, value in report.get("summary", {}).items():
            summary_rows.append({"Metric": key, "Value": value})
        for key, value in report.get("type_counts", {}).items():
            summary_rows.append({"Metric": f"issue_type:{key}", "Value": value})

        files: Dict[str, Dict[str, Any]] = {}
        if summary_rows:
            summary_df = pd.DataFrame(summary_rows)
            summary_file_id = FileService.create_new_file(summary_df, f"{run_id}_summary_report.csv")
            files["summary_report"] = {"file_id": summary_file_id, "records": len(summary_df)}

        if issue_rows:
            issues_df = pd.DataFrame(issue_rows)
            issues_file_id = FileService.create_new_file(issues_df, f"{run_id}_issue_report.csv")
            files["issues_report"] = {"file_id": issues_file_id, "records": len(issues_df)}

        if audit_rows:
            audit_df = pd.DataFrame(audit_rows)
            audit_file_id = FileService.create_new_file(audit_df, f"{run_id}_audit_report.csv")
            files["audit_report"] = {"file_id": audit_file_id, "records": len(audit_df)}

        cls._record_audit(run_id, None, "report_exported", "system", f"Generated {len(files)} report export file(s)", None, None)
        return {"run_id": run_id, "files": files, "report": report}
