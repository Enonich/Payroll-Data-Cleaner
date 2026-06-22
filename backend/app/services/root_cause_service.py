"""
Root Cause Analysis Engine.
Analyzes correlated field changes to explain WHY values changed,
not just THAT they changed.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple

import pandas as pd


class RootCauseAnalyzer:
    """
    Analyzes field-level differences and generates root cause explanations
    by examining correlations between changes on a per-employee basis.

    Examples:
      - "Salary increased by GHS 1,500. Possible reason: Rank changed from
        Officer II to Senior Officer."
      - "Take Home reduced by GHS 700. Reason: Credit Union deduction
        increased."
      - "Tax increased by GHS 230. Reason: Basic salary increased."
    """

    # Change type labels for human-readable output
    CHANGE_LABELS = {
        "increase": "increased",
        "decrease": "decreased",
        "no_change": "remained unchanged",
    }

    @staticmethod
    def _format_currency(value: Any) -> str:
        """Format a value as a currency string."""
        try:
            v = float(value)
            return f"GHS {v:,.2f}"
        except (TypeError, ValueError):
            return str(value)

    @staticmethod
    def _compute_difference(val1: Any, val2: Any) -> Optional[float]:
        """Compute numeric difference between two values."""
        try:
            v1 = float(val1) if val1 is not None else 0.0
            v2 = float(val2) if val2 is not None else 0.0
            return v2 - v1
        except (TypeError, ValueError):
            return None

    @staticmethod
    def _classify_change(diff: Optional[float]) -> str:
        """Classify a difference as increase, decrease, or no_change."""
        if diff is None:
            return "no_change"
        if abs(diff) < 0.01:
            return "no_change"
        return "increase" if diff > 0 else "decrease"

    @classmethod
    def _format_change(cls, field: str, diff: Optional[float], old_val: Any, new_val: Any) -> Optional[str]:
        """Format a single field change as a human-readable sentence."""
        if diff is None:
            return None
        change_type = cls._classify_change(diff)
        if change_type == "no_change":
            return None

        abs_diff = abs(diff)
        direction = "increased" if diff > 0 else "decreased"

        return (
            f"{field} {direction} by {cls._format_currency(abs_diff)} "
            f"(from {cls._format_currency(old_val)} to {cls._format_currency(new_val)})."
        )

    @classmethod
    def _analyze_salary_cause(
        cls,
        changes: Dict[str, Dict[str, Any]],
    ) -> Optional[str]:
        """
        If salary changed, determine possible cause from correlated changes.
        """
        sal_change = changes.get("salary_change") or changes.get("basic_salary")
        if not sal_change:
            return None

        sal_diff = sal_change.get("difference", 0)
        if abs(sal_diff) < 0.01:
            return None

        possible_reasons = []

        # Check for rank/grade change
        rank_change = changes.get("rank_change")
        if rank_change and abs(rank_change.get("difference", 0)) > 0:
            possible_reasons.append(
                f"Rank changed from {rank_change.get('old_value', '?')} "
                f"to {rank_change.get('new_value', '?')}."
            )

        # Check for branch change (transfer with possible salary adjustment)
        branch_change = changes.get("branch_change")
        if branch_change:
            possible_reasons.append(
                f"Branch changed from {branch_change.get('old_value', '?')} "
                f"to {branch_change.get('new_value', '?')} (possible transfer)."
            )

        # Check for allowance change
        allowance_change = changes.get("allowance_change")
        if allowance_change and abs(allowance_change.get("difference", 0)) > 0:
            possible_reasons.append(
                f"Allowance {cls._classify_change(allowance_change.get('difference'))} "
                f"by {cls._format_currency(abs(allowance_change.get('difference', 0)))}."
            )

        if possible_reasons:
            direction = "increased" if sal_diff > 0 else "decreased"
            return (
                f"Salary {direction} by {cls._format_currency(abs(sal_diff))}. "
                f"Possible reason(s): {' '.join(possible_reasons)}"
            )

        # No correlated change found
        direction = "increased" if sal_diff > 0 else "decreased"
        return (
            f"Salary {direction} by {cls._format_currency(abs(sal_diff))}. "
            f"No rank or allowance change detected to explain this. "
            f"May require verification."
        )

    @classmethod
    def _analyze_tax_cause(
        cls,
        changes: Dict[str, Dict[str, Any]],
    ) -> Optional[str]:
        """
        If tax changed, determine if it's due to salary/basic change.
        """
        tax_change = changes.get("tax_change") or changes.get("income_tax")
        if not tax_change:
            return None

        tax_diff = tax_change.get("difference", 0)
        if abs(tax_diff) < 0.01:
            return None

        possible_reasons = []

        # Tax usually follows basic salary changes
        basic_change = changes.get("basic_salary") or changes.get("salary_change")
        if basic_change and abs(basic_change.get("difference", 0)) > 0:
            possible_reasons.append(
                f"Basic salary {cls._classify_change(basic_change.get('difference'))} "
                f"by {cls._format_currency(abs(basic_change.get('difference', 0)))}."
            )

        # Or grade/rank change affecting tax bracket
        rank_change = changes.get("rank_change")
        if rank_change and abs(rank_change.get("difference", 0)) > 0:
            possible_reasons.append(
                f"Rank changed, potentially affecting tax bracket."
            )

        if possible_reasons:
            direction = "increased" if tax_diff > 0 else "decreased"
            return (
                f"Income Tax {direction} by {cls._format_currency(abs(tax_diff))}. "
                f"Reason: {' '.join(possible_reasons)}"
            )

        direction = "increased" if tax_diff > 0 else "decreased"
        return (
            f"Income Tax {direction} by {cls._format_currency(abs(tax_diff))}. "
            f"No clear underlying cause detected."
        )

    @classmethod
    def _analyze_take_home_cause(
        cls,
        changes: Dict[str, Dict[str, Any]],
    ) -> Optional[str]:
        """
        If Take Home changed, find the deduction that caused it.
        """
        take_home_change = changes.get("take_home_change") or changes.get("take_home")
        if not take_home_change:
            return None

        th_diff = take_home_change.get("difference", 0)
        if abs(th_diff) < 0.01:
            return None

        # Find the largest deduction change that explains the take-home change
        deduction_changes = []
        for field_key, change in changes.items():
            if any(d in field_key for d in ["deduction", "pf", "ssnit", "tax", "loan"]):
                diff = change.get("difference", 0)
                if abs(diff) > 0.01:
                    deduction_changes.append((abs(diff), field_key, change))

        if deduction_changes:
            deduction_changes.sort(key=lambda x: x[0], reverse=True)
            _, field, primary = deduction_changes[0]
            direction = "increased" if primary.get("difference", 0) > 0 else "decreased"

            reason = (
                f"Take Home {cls._classify_change(th_diff)} by "
                f"{cls._format_currency(abs(th_diff))}. "
                f"Primary driver: {field.replace('_', ' ').title()} {direction} "
                f"by {cls._format_currency(abs(primary.get('difference', 0)))}."
            )

            # List other contributing deductions
            if len(deduction_changes) > 1:
                others = [
                    f"{field.replace('_', ' ').title()} ({cls._format_currency(abs(diff))})"
                    for diff, field, _ in deduction_changes[1:3]
                ]
                if others:
                    reason += f" Contributing: {', '.join(others)}."

            return reason

        direction = "increased" if th_diff > 0 else "decreased"
        return (
            f"Take Home {direction} by {cls._format_currency(abs(th_diff))}. "
            f"No specific deduction change detected."
        )

    @classmethod
    def _analyze_allowance_cause(
        cls,
        changes: Dict[str, Dict[str, Any]],
    ) -> Optional[str]:
        """
        Explain allowance changes in context.
        """
        allowance_changes = {
            k: v for k, v in changes.items()
            if "allowance" in k and v.get("difference", 0) != 0
        }

        if not allowance_changes:
            return None

        explanations = []
        for field, change in allowance_changes.items():
            diff = change.get("difference", 0)
            if abs(diff) > 0.01:
                explanations.append(
                    f"{field.replace('_', ' ').title()} {cls._classify_change(diff)} "
                    f"by {cls._format_currency(abs(diff))}."
                )

        return " ".join(explanations) if explanations else None

    @classmethod
    def analyze_employee_changes(
        cls,
        employee_id: str,
        changes: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Analyze all changes for a single employee and produce root cause explanations.

        changes: list of dicts with keys:
            field, old_value, new_value, difference, issue_type
        """
        # Group changes by field/type
        change_map: Dict[str, Dict[str, Any]] = {}
        for c in changes:
            field = c.get("field", "").lower().replace(" ", "_")
            issue_type = c.get("issue_type", "")
            diff = c.get("difference")

            # Use issue_type as key for known types
            key = issue_type if issue_type and issue_type != "field_mismatch" else field

            change_map[key] = {
                "field": c.get("field"),
                "old_value": c.get("old_value"),
                "new_value": c.get("new_value"),
                "difference": diff,
                "abs_difference": abs(diff) if diff is not None else 0,
            }

        # Generate root cause explanations
        explanations: List[str] = []

        # Core analysis
        for analyzer in [
            cls._analyze_salary_cause,
            cls._analyze_tax_cause,
            cls._analyze_take_home_cause,
            cls._analyze_allowance_cause,
        ]:
            explanation = analyzer(change_map)
            if explanation:
                explanations.append(explanation)

        # Fallback: basic field-level explanations for remaining changes
        analyzed_keys = set()
        for expl in explanations:
            for key in change_map:
                if key.replace("_", " ") in expl.lower():
                    analyzed_keys.add(key)

        for key, change in change_map.items():
            if key in analyzed_keys:
                continue
            diff = change.get("difference")
            if diff is None or abs(diff) < 0.01:
                continue

            direction = cls._classify_change(diff)
            if direction == "no_change":
                continue

            label = change.get("field", key.replace("_", " ").title())
            explanations.append(
                f"{label} {direction} from {change.get('old_value', '?')} "
                f"to {change.get('new_value', '?')}."
            )

        # Summary
        total_delta = sum(
            abs(c.get("difference", 0))
            for c in change_map.values()
            if c.get("difference") is not None
        )

        return {
            "employee_id": employee_id,
            "explanations": explanations,
            "total_change_amount": round(total_delta, 2),
            "changed_fields": len(change_map),
        }

    @classmethod
    def analyze_reconciliation_issues(
        cls,
        issues: List[Dict[str, Any]],
    ) -> Dict[str, Any]:
        """
        Analyze a list of reconciliation issues and attach root cause explanations.
        Issues are grouped by employee_id.

        Returns dict with:
          - employee_analyses: per-employee analysis
          - global_summary: aggregate across all employees
        """
        from collections import defaultdict

        # Group issues by employee
        employee_issues: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for issue in issues:
            emp_id = issue.get("employee_id") or "unknown"
            employee_issues[emp_id].append(issue)

        # Analyze each employee
        analyses = []
        total_change = 0.0
        total_affected = 0

        for emp_id, emp_issues in employee_issues.items():
            analysis = cls.analyze_employee_changes(emp_id, emp_issues)
            analyses.append(analysis)
            total_change += analysis["total_change_amount"]
            total_affected += 1

        return {
            "employee_analyses": analyses,
            "global_summary": {
                "total_employees_analyzed": total_affected,
                "total_change_across_all": round(total_change, 2),
                "average_change_per_employee": round(total_change / max(total_affected, 1), 2),
            },
        }
