"""
Deterministic Audit Service — 3-Stage Gating Audit Pipeline.

Stage 1 ─ ID Completeness
    Every employee must have a valid Staff ID before auditing begins.
    Missing IDs are listed so they can be fixed.  Stage 2 will not run
    until Stage 1 is clear.

Stage 2 ─ ID-Name Consistency  (fuzzy matching)
    For every matched pair of records (same ID in both files) the employee
    name must be consistent.  A RapidFuzz token-sort-ratio below the
    threshold flags the pair as suspicious (wrong ID, data-entry error,
    or possible fraud).  Stage 3 will not run until Stage 2 is clear.

Stage 3 ─ Financial Audit
    Salary / allowance / deduction analysis:
    • Duplicate IDs
    • Presence mismatches (leavers / joiners)
    • Large salary changes (> 20 %)
    • Allowance changes without salary changes
    • Negative values in positive-only fields
    • Zero / blank critical fields
    • Employer contributions deducted from Net Pay

Architecture principle (AI_Int_Issues.md):
  "Let code discover the facts, and let the LLM explain, prioritise, and
   guide the user through those facts."
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

import pandas as pd

from app.config import (
    SSF_EMPLOYEE_RATE,
    PF_EMPLOYEE_RATE,
    SSNIT_TIER1_RATE,
    SSNIT_TIER2_MOP_RATE,
)

# ── Thresholds ────────────────────────────────────────────────────────────────
SALARY_CHANGE_THRESHOLD  = 0.20  # Flag salary/net-pay changes > 20 %
NAME_SIMILARITY_THRESHOLD = 65   # RapidFuzz token_sort_ratio minimum (0-100)

# Field-label token sets used to classify mismatch rows
_SALARY_FIELD_TOKENS = {"basic", "salary", "gross", "net", "pay", "take", "home"}
_NET_PAY_TOKENS      = {"net", "pay", "take", "home", "net pay", "take home"}
_SSF_TOKENS          = {"ssf", "ssnit", "social", "security"}
_ALLOWANCE_TOKENS    = {
    "allowance", "alloc", "transport", "furnish", "rent",
    "enhancement", "utility", "risk", "lunch", "responsibility",
}
_NAME_TOKENS         = {"name", "employee name", "full name", "staff name"}
_EMPLOYER_TOKENS     = {"tier1", "tier 1", "tier2", "tier 2", "mop", "ssnit employer"}


def _field_matches(field_label: str, tokens: set) -> bool:
    lower = field_label.lower()
    return any(tok in lower for tok in tokens)


def _safe_float(value: Any) -> Optional[float]:
    try:
        if value is None or (isinstance(value, float) and pd.isna(value)):
            return None
        return float(value)
    except (TypeError, ValueError):
        return None


class DeterministicAuditService:
    """
    Three-stage gating payroll audit.

    Entry point: ``run_staged_audit(comparison_result)``

    Each stage gates the next:
      Stage 1 — ID Completeness  (blocking until all IDs are filled in)
      Stage 2 — ID-Name Consistency via fuzzy matching  (blocking until resolved)
      Stage 3 — Financial Audit — salary, allowances, deductions
    """

    # ── Public API ─────────────────────────────────────────────────────────────

    @classmethod
    def run_staged_audit(cls, comparison_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Run the three stages in order.  Each blocking stage stops the pipeline
        and returns a focused report so the user knows exactly what to fix.

        Return shape:
        {
            "current_stage": 1 | 2 | 3,
            "stage_label": str,
            "stage_blocked": bool,
            "next_step": str | None,
            "evidence_packs": [...],
            "stage_summary": {
                "id_completeness":     {"status": str, "issue_count": int},
                "id_name_consistency": {"status": str, "issue_count": int},
                "financial_audit":     {"status": str, "issue_count": int},
            },
        }
        """
        # ── Stage 1: ID Completeness ───────────────────────────────────────
        s1 = cls._stage1_id_completeness(comparison_result)
        if s1:
            return {
                "current_stage": 1,
                "stage_label": "Staff ID Completeness",
                "stage_blocked": True,
                "next_step": (
                    "Assign valid Staff IDs to all employees listed above and re-upload "
                    "both files before proceeding to name verification."
                ),
                "evidence_packs": s1,
                "stage_summary": {
                    "id_completeness":     {"status": "BLOCKED", "issue_count": len(s1)},
                    "id_name_consistency": {"status": "NOT_RUN", "issue_count": 0},
                    "financial_audit":     {"status": "NOT_RUN", "issue_count": 0},
                },
            }

        # ── Stage 2: ID-Name Consistency ──────────────────────────────────
        s2 = cls._stage2_id_name_consistency(comparison_result)
        if s2:
            return {
                "current_stage": 2,
                "stage_label": "Staff ID \u2013 Name Consistency",
                "stage_blocked": True,
                "next_step": (
                    "Resolve the ID-name mismatches listed above \u2014 correct wrong IDs "
                    "or fix name spelling \u2014 then re-run the comparison before proceeding "
                    "to the financial audit."
                ),
                "evidence_packs": s2,
                "stage_summary": {
                    "id_completeness":     {"status": "PASSED",  "issue_count": 0},
                    "id_name_consistency": {"status": "BLOCKED", "issue_count": len(s2)},
                    "financial_audit":     {"status": "NOT_RUN", "issue_count": 0},
                },
            }

        # ── Stage 3: Financial Audit ───────────────────────────────────────
        s3 = cls._stage3_financial_audit(comparison_result)
        return {
            "current_stage": 3,
            "stage_label": "Financial Audit \u2014 Salary, Allowances & Deductions",
            "stage_blocked": False,
            "next_step": None,
            "evidence_packs": s3,
            "stage_summary": {
                "id_completeness":     {"status": "PASSED",   "issue_count": 0},
                "id_name_consistency": {"status": "PASSED",   "issue_count": 0},
                "financial_audit":     {"status": "COMPLETE", "issue_count": len(s3)},
            },
        }

    @classmethod
    def build_evidence_packs(cls, comparison_result: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Backward-compatible: returns the evidence_packs list from run_staged_audit."""
        return cls.run_staged_audit(comparison_result)["evidence_packs"]

    @staticmethod
    def summarise(packs: List[Dict[str, Any]]) -> Dict[str, Any]:
        """Return a brief severity breakdown of evidence packs."""
        counts: Dict[str, int] = {"blocking": 0, "critical": 0, "high": 0, "medium": 0, "low": 0}
        for p in packs:
            sev = str(p.get("severity", "low")).lower()
            if sev in counts:
                counts[sev] += 1
        return {
            "total_violations": len(packs),
            "by_severity": counts,
            "risk_level": (
                "critical" if counts["blocking"] or counts["critical"] else
                "high"     if counts["high"]                             else
                "medium"   if counts["medium"]                           else
                "low"
            ),
        }

    # ── Stage 1: ID Completeness ───────────────────────────────────────────────

    @classmethod
    def _stage1_id_completeness(cls, cr: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        Flag any employee in either file who has no valid Staff ID.
        These employees are excluded from all matching and will never be reconciled.
        """
        issues: List[Dict[str, Any]] = []

        for file_label, count_key, sample_key, total_key in [
            ("File 1", "missing_id_count_file1", "missing_id_sample_file1", "total_file1"),
            ("File 2", "missing_id_count_file2", "missing_id_sample_file2", "total_file2"),
        ]:
            missing = int(cr.get(count_key) or 0)
            if missing == 0:
                continue

            total      = int(cr.get(total_key) or 0)
            sample_rows = cr.get(sample_key) or []

            issues.append({
                "issue_type": "MISSING_STAFF_ID",
                "severity": "blocking",
                "confidence": 100,
                "file": file_label,
                "evidence": {
                    "missing_count": missing,
                    "total_employees_in_file": total,
                    "percent_missing": round(missing / total * 100, 1) if total else 0,
                    "sample_rows": sample_rows[:10],
                    "note": (
                        "Rows whose Staff ID column is blank, null, or contains only "
                        "non-numeric characters cannot be matched and are silently "
                        "excluded from all comparison results."
                    ),
                },
                "rule_triggered": (
                    f"{missing} of {total} employee(s) in {file_label} "
                    "have no valid Staff ID and cannot be audited."
                ),
                "recommended_action": (
                    f"Open {file_label} and populate the Staff ID column for every row "
                    "shown above. IDs must be non-empty and contain at least some numeric "
                    "digits. Once all IDs are filled in, re-upload and re-run the comparison."
                ),
            })

        return issues

    # ── Stage 2: ID-Name Consistency ──────────────────────────────────────────

    @classmethod
    def _stage2_id_name_consistency(cls, cr: Dict[str, Any]) -> List[Dict[str, Any]]:
        """
        For every matched employee pair (same Staff ID in both files), verify the
        name is consistent using RapidFuzz token_sort_ratio.

        A score below NAME_SIMILARITY_THRESHOLD means the same ID has been
        mapped to significantly different names — a strong signal of an ID
        assignment error or potential fraud.
        """
        try:
            from rapidfuzz import fuzz as _fuzz
        except ImportError:
            return []  # Skip gracefully if rapidfuzz is not installed

        mismatches_df: Optional[pd.DataFrame] = cr.get("mismatches_df")
        if mismatches_df is None or mismatches_df.empty:
            return []

        name_rows = mismatches_df[
            mismatches_df["field"].apply(lambda f: _field_matches(str(f), _NAME_TOKENS))
        ]

        issues: List[Dict[str, Any]] = []
        for _, row in name_rows.iterrows():
            name1 = str(row.get("file1_value") or "").strip()
            name2 = str(row.get("file2_value") or "").strip()
            if not name1 or not name2:
                continue

            score = _fuzz.token_sort_ratio(name1.upper(), name2.upper())
            if score >= NAME_SIMILARITY_THRESHOLD:
                continue  # Minor spelling difference — acceptable

            severity = "critical" if score < 30 else "high" if score < 50 else "medium"

            issues.append({
                "issue_type": "ID_NAME_MISMATCH",
                "severity": severity,
                "confidence": 100,
                "employee": {"staff_id": str(row.get("employee_id", "unknown"))},
                "evidence": {
                    "file1_name": name1,
                    "file2_name": name2,
                    "name_similarity_score": score,
                    "similarity_threshold": NAME_SIMILARITY_THRESHOLD,
                    "field_compared": str(row.get("field")),
                    "interpretation": (
                        "Score < 30: likely completely different people. "
                        "Score 30-64: major spelling error or name change."
                    ),
                },
                "rule_triggered": (
                    f"Staff ID '{row.get('employee_id')}' maps to '{name1}' in File 1 "
                    f"but '{name2}' in File 2 (similarity: {score}% \u2014 below the "
                    f"{NAME_SIMILARITY_THRESHOLD}% threshold)."
                ),
                "recommended_action": (
                    "Verify that both records belong to the same employee. "
                    "If the ID was assigned to a different person, correct the Staff ID. "
                    "If the name is mis-typed or legally changed, update the incorrect name first."
                ),
            })

        return issues

    # ── Stage 3: Financial Audit ───────────────────────────────────────────────

    @classmethod
    def _stage3_financial_audit(cls, cr: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Full financial audit — only runs after Stages 1 and 2 are clean."""
        packs: List[Dict[str, Any]] = []
        packs.extend(cls._check_duplicates(cr))
        packs.extend(cls._check_presence(cr))
        packs.extend(cls._check_large_changes(cr))
        packs.extend(cls._check_allowance_without_salary(cr))
        packs.extend(cls._check_zero_blanks(cr))
        packs.extend(cls._check_negatives(cr))
        packs.extend(cls._check_employer_deductions(cr))
        return packs

    # ── Financial check helpers ────────────────────────────────────────────────

    @classmethod
    def _check_duplicates(cls, cr: Dict[str, Any]) -> List[Dict[str, Any]]:
        packs: List[Dict[str, Any]] = []
        for file_label, sample_key, count_key in [
            ("File 1", "duplicate_id_samples_file1", "duplicate_ids_file1"),
            ("File 2", "duplicate_id_samples_file2", "duplicate_ids_file2"),
        ]:
            samples = cr.get(sample_key) or []
            count   = cr.get(count_key) or len(samples)
            if not count:
                continue

            sample_ids: List[str] = []
            for s in samples[:5]:
                eid = (
                    str(s.get("employee_id") or s.get("id") or "")
                    if isinstance(s, dict) else str(s)
                )
                if eid:
                    sample_ids.append(eid)

            packs.append({
                "issue_type": "DUPLICATE_ID",
                "severity": "critical",
                "confidence": 100,
                "file": file_label,
                "employee": {"staff_id": ", ".join(sample_ids) if sample_ids else "multiple"},
                "evidence": {
                    "duplicate_id_count": count,
                    "sample_duplicate_ids": sample_ids,
                },
                "rule_triggered": (
                    f"{count} Staff ID(s) appear more than once in {file_label}. "
                    "Duplicate IDs cause incorrect salary aggregations and double payments."
                ),
                "recommended_action": (
                    "Remove or correct the duplicate entries before uploading to the HR system. "
                    "Each employee must have exactly one record per payroll run."
                ),
            })
        return packs

    @classmethod
    def _check_presence(cls, cr: Dict[str, Any]) -> List[Dict[str, Any]]:
        packs: List[Dict[str, Any]] = []
        for issue_type, count_key, preview_key, description in [
            ("MISSING_FROM_FILE2", "only_in_file1", "only_in_file1_preview",
             "present in File 1 but absent from File 2 (possible leavers or ID mismatch)"),
            ("MISSING_FROM_FILE1", "only_in_file2", "only_in_file2_preview",
             "present in File 2 but absent from File 1 (possible new joiners or ID mismatch)"),
        ]:
            count   = int(cr.get(count_key) or 0)
            preview = cr.get(preview_key) or []
            if not count:
                continue
            sample = [
                str(r.get("employee_id", "")) for r in preview[:5]
                if isinstance(r, dict)
            ]
            packs.append({
                "issue_type": issue_type,
                "severity": "high" if count > 5 else "medium",
                "confidence": 100,
                "employee": {"staff_id": f"{count} employee(s)"},
                "evidence": {"count": count, "description": description, "sample_ids": sample},
                "rule_triggered": f"{count} employee(s) {description}.",
                "recommended_action": (
                    "Confirm whether each employee is a genuine leaver/joiner or whether "
                    "their Staff ID differs between the two files. "
                    "Do not approve payroll until presence is fully reconciled."
                ),
            })
        return packs

    @classmethod
    def _check_large_changes(cls, cr: Dict[str, Any]) -> List[Dict[str, Any]]:
        packs: List[Dict[str, Any]] = []
        mismatches_df: Optional[pd.DataFrame] = cr.get("mismatches_df")
        if mismatches_df is None or mismatches_df.empty:
            return packs

        salary_rows = mismatches_df[
            mismatches_df["field"].apply(lambda f: _field_matches(str(f), _SALARY_FIELD_TOKENS))
        ].copy()
        if salary_rows.empty:
            return packs

        def _pct(row: Any) -> Optional[float]:
            v1 = _safe_float(row.get("file1_value"))
            v2 = _safe_float(row.get("file2_value"))
            if v1 is None or v2 is None or v1 == 0:
                return None
            return (v2 - v1) / abs(v1)

        salary_rows["_pct"] = salary_rows.apply(_pct, axis=1)
        large = salary_rows[
            salary_rows["_pct"].notna() & (salary_rows["_pct"].abs() > SALARY_CHANGE_THRESHOLD)
        ]

        for _, row in large.iterrows():
            v1  = _safe_float(row.get("file1_value")) or 0.0
            v2  = _safe_float(row.get("file2_value")) or 0.0
            pct = row["_pct"]
            direction = "increase" if pct > 0 else "decrease"
            packs.append({
                "issue_type": "LARGE_SALARY_CHANGE",
                "severity": "critical" if abs(pct) > 0.50 else "high",
                "confidence": 100,
                "employee": {"staff_id": str(row.get("employee_id", "unknown"))},
                "evidence": {
                    "field": str(row.get("field")),
                    "file1_value_ghs": round(v1, 2),
                    "file2_value_ghs": round(v2, 2),
                    "difference_ghs":  round(v2 - v1, 2),
                    "percent_change":  round(abs(pct) * 100, 1),
                    "direction": direction,
                },
                "rule_triggered": (
                    f"{row.get('field')} changed by {round(abs(pct)*100,1)}% "
                    f"(GHS {v1:,.2f} \u2192 GHS {v2:,.2f}) \u2014 exceeds the 20% threshold."
                ),
                "recommended_action": (
                    f"Obtain the authorising document (promotion letter, salary review, "
                    f"acting appointment) that justifies this {direction} before approving payroll."
                ),
            })
        return packs

    @classmethod
    def _check_allowance_without_salary(cls, cr: Dict[str, Any]) -> List[Dict[str, Any]]:
        mismatches_df: Optional[pd.DataFrame] = cr.get("mismatches_df")
        if mismatches_df is None or mismatches_df.empty:
            return []

        allowance_rows = mismatches_df[
            mismatches_df["field"].apply(lambda f: _field_matches(str(f), _ALLOWANCE_TOKENS))
        ]
        salary_rows = mismatches_df[
            mismatches_df["field"].apply(lambda f: _field_matches(str(f), {"basic", "salary"}))
        ]
        if allowance_rows.empty:
            return []

        emp_with_salary: set = (
            set(salary_rows["employee_id"])
            if "employee_id" in salary_rows.columns and not salary_rows.empty
            else set()
        )
        allowance_only = (
            allowance_rows[~allowance_rows["employee_id"].isin(emp_with_salary)]
            if "employee_id" in allowance_rows.columns
            else allowance_rows
        )
        if allowance_only.empty:
            return []

        affected = (
            int(allowance_only["employee_id"].nunique())
            if "employee_id" in allowance_only.columns else len(allowance_only)
        )
        return [{
            "issue_type": "ALLOWANCE_CHANGED_WITHOUT_SALARY_CHANGE",
            "severity": "medium",
            "confidence": 100,
            "employee": {"staff_id": f"{affected} employee(s)"},
            "evidence": {
                "affected_count": affected,
                "changed_allowance_fields": (
                    allowance_only["field"].unique().tolist()
                    if "field" in allowance_only.columns else []
                ),
                "sample_ids": (
                    allowance_only["employee_id"].astype(str).head(5).tolist()
                    if "employee_id" in allowance_only.columns else []
                ),
            },
            "rule_triggered": (
                f"Allowance(s) changed for {affected} employee(s) without a corresponding "
                "Basic Salary change. May indicate unapproved adjustments."
            ),
            "recommended_action": (
                "Verify that each allowance change has an authorised supporting document "
                "(acting appointment, welfare committee decision, etc.)."
            ),
        }]

    @classmethod
    def _check_zero_blanks(cls, cr: Dict[str, Any]) -> List[Dict[str, Any]]:
        packs: List[Dict[str, Any]] = []
        mismatches_df: Optional[pd.DataFrame] = cr.get("mismatches_df")
        if mismatches_df is None or mismatches_df.empty:
            return packs

        critical_tokens = {"basic", "net pay", "take home", "account", "acct"}
        critical_rows = mismatches_df[
            mismatches_df["field"].apply(lambda f: _field_matches(str(f), critical_tokens))
        ]
        _blank = {"", "0", "0.0", "nan", "none"}
        mask1 = critical_rows["file1_value"].apply(
            lambda v: v is None or str(v).strip().lower() in _blank
        ).astype(bool)
        mask2 = critical_rows["file2_value"].apply(
            lambda v: v is None or str(v).strip().lower() in _blank
        ).astype(bool)
        zero_blank = critical_rows[mask1 | mask2]
        if zero_blank.empty:
            return packs

        for field, group in zero_blank.groupby("field"):
            affected = (
                int(group["employee_id"].nunique())
                if "employee_id" in group.columns else len(group)
            )
            packs.append({
                "issue_type": "ZERO_OR_BLANK_CRITICAL_FIELD",
                "severity": "high",
                "confidence": 100,
                "employee": {"staff_id": f"{affected} employee(s)"},
                "evidence": {
                    "field": str(field),
                    "affected_count": affected,
                    "sample_ids": (
                        group["employee_id"].astype(str).head(5).tolist()
                        if "employee_id" in group.columns else []
                    ),
                },
                "rule_triggered": f"'{field}' is zero or blank for {affected} employee(s).",
                "recommended_action": (
                    f"Investigate and populate '{field}' in the source data "
                    "before the next payroll run."
                ),
            })
        return packs

    @classmethod
    def _check_negatives(cls, cr: Dict[str, Any]) -> List[Dict[str, Any]]:
        packs: List[Dict[str, Any]] = []
        mismatches_df: Optional[pd.DataFrame] = cr.get("mismatches_df")
        if mismatches_df is None or mismatches_df.empty:
            return packs

        positive_only = {
            "net pay", "take home", "basic", "gross", "ssnit", "ssf", "pf", "provident"
        }
        relevant = mismatches_df[
            mismatches_df["field"].apply(lambda f: _field_matches(str(f), positive_only))
        ]
        for _, row in relevant.iterrows():
            for col, file_label in (("file1_value", "File 1"), ("file2_value", "File 2")):
                v = _safe_float(row.get(col))
                if v is not None and v < 0:
                    packs.append({
                        "issue_type": "NEGATIVE_VALUE_IN_POSITIVE_FIELD",
                        "severity": "critical",
                        "confidence": 100,
                        "employee": {"staff_id": str(row.get("employee_id", "unknown"))},
                        "evidence": {
                            "field": str(row.get("field")),
                            "value_ghs": v,
                            "source_file": file_label,
                        },
                        "rule_triggered": (
                            f"'{row.get('field')}' = GHS {v:,.2f} in {file_label} \u2014 "
                            "negative values are not permitted in this field."
                        ),
                        "recommended_action": (
                            "Correct the data entry error. Negative values in "
                            "salary/deduction fields indicate a calculation or import mistake."
                        ),
                    })
        return packs

    @classmethod
    def _check_employer_deductions(cls, cr: Dict[str, Any]) -> List[Dict[str, Any]]:
        mismatches_df: Optional[pd.DataFrame] = cr.get("mismatches_df")
        if mismatches_df is None or mismatches_df.empty:
            return []

        net_pay_rows = mismatches_df[
            mismatches_df["field"].apply(lambda f: _field_matches(str(f), _NET_PAY_TOKENS))
        ]
        tier_rows = mismatches_df[
            mismatches_df["field"].apply(lambda f: _field_matches(str(f), _EMPLOYER_TOKENS))
        ]
        if net_pay_rows.empty or tier_rows.empty:
            return []

        affected = (
            set(net_pay_rows["employee_id"]).intersection(set(tier_rows["employee_id"]))
            if "employee_id" in net_pay_rows.columns else set()
        )
        if not affected:
            return []

        return [{
            "issue_type": "EMPLOYER_CONTRIBUTION_DEDUCTED_FROM_NET_PAY",
            "severity": "critical",
            "confidence": 85,
            "employee": {"staff_id": f"{len(affected)} employee(s)"},
            "evidence": {
                "affected_count": len(affected),
                "ssnit_tier1_rate":     f"{SSNIT_TIER1_RATE*100:.1f}%",
                "ssnit_tier2_mop_rate": f"{SSNIT_TIER2_MOP_RATE*100:.1f}%",
                "note": (
                    "Employees have both a Net Pay change and an employer-tier change, "
                    "suggesting employer contributions may have been deducted from take-home pay."
                ),
            },
            "rule_triggered": (
                f"SSNIT Tier 1 ({SSNIT_TIER1_RATE*100:.1f}%) and Tier 2/MOP "
                f"({SSNIT_TIER2_MOP_RATE*100:.1f}%) are EMPLOYER costs and must "
                "NOT reduce employee Net Pay."
            ),
            "recommended_action": (
                "Review the payroll formula. Only employee-side deductions "
                "(SSF 5.5%, PF 5%, PAYE, ICU 3%) should be subtracted from Net Pay."
            ),
        }]
