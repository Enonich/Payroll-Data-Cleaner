"""
Persistent payroll reconciliation runs, issue review, audit, and HR exports.
"""
from __future__ import annotations

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
        try:
            if pd.isna(value):
                return None
        except (TypeError, ValueError):
            pass
        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, pd.Timestamp):
            return value.isoformat()
        if hasattr(value, "isoformat"):
            try:
                return value.isoformat()
            except (TypeError, ValueError):
                pass
        if isinstance(value, dict):
            return {str(k): cls._json_safe_value(v) for k, v in value.items()}
        if isinstance(value, list):
            return [cls._json_safe_value(v) for v in value]
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
    def _classify_field_issue(cls, row: Dict[str, Any], employee_fields: Dict[str, set]) -> Dict[str, Any]:
        field = str(row.get("field") or "").strip()
        field_key = field.lower()
        employee_id = cls._string_value(row.get("employee_id"))
        difference = row.get("difference")
        try:
            numeric_difference = float(difference) if difference is not None else None
        except (TypeError, ValueError):
            numeric_difference = None

        issue_type = "field_mismatch"
        suggested_action = "Review field change"
        explanation = f"{field or 'Field'} differs between the HR file and payroll file."

        if any(token in field_key for token in ["rank", "grade", "level"]):
            issue_type = "rank_change"
            suggested_action = "Approve HR rank update if promotion/grade change is valid"
            explanation = f"Rank changed from {row.get('file1_value')} to {row.get('file2_value')}."
        elif any(token in field_key for token in ["branch", "location", "office"]):
            issue_type = "branch_change"
            suggested_action = "Approve HR branch update if transfer is valid"
            explanation = f"Branch changed from {row.get('file1_value')} to {row.get('file2_value')}."
        elif any(token in field_key for token in ["allowance", "ssf", "pf", "tax", "deduction"]):
            issue_type = "allowance_or_deduction_change"
            suggested_action = "Review payroll component change"
            if numeric_difference is not None:
                explanation = f"{field} changed by {numeric_difference:,.2f}."
        elif any(token in field_key for token in ["salary", "basic", "gross", "take home", "net pay", "pay"]):
            issue_type = "salary_change"
            suggested_action = "Approve HR salary update if authorized"
            if numeric_difference is not None:
                explanation = f"{field} changed by {numeric_difference:,.2f}."
            employee_known_fields = employee_fields.get(employee_id or "", set())
            if employee_known_fields.intersection({"rank_change", "grade_change"}):
                explanation += " Possible reason: rank or grade changed for the same employee."

        return {
            "issue_type": issue_type,
            "suggested_action": suggested_action,
            "explanation": explanation,
            "difference": numeric_difference,
        }

    @classmethod
    def _issue_rows_from_result(cls, result: Dict[str, Any]) -> List[Dict[str, Any]]:
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
            classified = cls._classify_field_issue(row, employee_fields)
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
                "old_value": "Present in HR",
                "new_value": "Missing from payroll",
                "difference": None,
                "confidence": 0.9,
                "suggested_action": "Generate HR offboarding/resignation review",
                "explanation": "Employee appears in File 1 but is missing from File 2.",
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
                "old_value": "Missing from HR",
                "new_value": "Present in payroll",
                "difference": None,
                "confidence": 0.9,
                "suggested_action": "Generate HR onboarding/import review",
                "explanation": "Employee appears in File 2 but is missing from File 1.",
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

        issue_rows = cls._issue_rows_from_result(result)
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
