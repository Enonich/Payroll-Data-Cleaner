"""
Payroll Calculation Validator.
Automatically validates Gross, SSNIT, PF, Taxable Income, Income Tax, and Take Home.
Configurable rules per organization.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple, Callable

import pandas as pd
import numpy as np

from app.services.cleaning_service import DataCleaningService


class PayrollValidator:
    """
    Validates payroll calculations against configurable rules.

    Default rules (Ghana standard):
      - Gross = Basic + Allowance
      - SSNIT (Employee) = Basic × 5%
      - Provident Fund = Basic × 4.5%
      - Taxable Income = Gross - SSNIT - PF
      - Income Tax: computed via progressive brackets
      - Take Home = Gross - Total Deductions
    """

    # Ghanaian tax brackets for 2024 (monthly)
    DEFAULT_TAX_BRACKETS = [
        (0, 490.0, 0.0),          # First GHS 490: 0%
        (490.0, 730.0, 0.05),     # Next GHS 240: 5%
        (730.0, 1160.0, 0.10),    # Next GHS 430: 10%
        (1160.0, 1660.0, 0.175),  # Next GHS 500: 17.5%
        (1660.0, 5000.0, 0.25),   # Next GHS 3,340: 25%
        (5000.0, 1000000000, 0.30),  # Above GHS 5,000: 30% (capped)
    ]

    @staticmethod
    def clean_currency(value: Any) -> float:
        """Safely convert a value to float."""
        return float(DataCleaningService.clean_currency_value(value))

    @classmethod
    def validate_gross(cls, basic: Any, allowance: Any, gross: Any, tolerance: float = 0.01) -> Tuple[bool, float, float]:
        """Validate Gross = Basic + Allowance."""
        b = cls.clean_currency(basic)
        a = cls.clean_currency(allowance)
        g = cls.clean_currency(gross)
        expected = b + a
        diff = abs(g - expected)
        return diff <= tolerance, expected, diff

    @classmethod
    def validate_ssnit(cls, basic: Any, ssnit: Any, rate: float = 0.05, tolerance: float = 0.01) -> Tuple[bool, float, float]:
        """Validate SSNIT = Basic × rate."""
        b = cls.clean_currency(basic)
        s = cls.clean_currency(ssnit)
        expected = round(b * rate, 2)
        diff = abs(s - expected)
        return diff <= tolerance, expected, diff

    @classmethod
    def validate_pf(cls, basic: Any, pf: Any, rate: float = 0.045, tolerance: float = 0.01) -> Tuple[bool, float, float]:
        """Validate PF = Basic × rate."""
        b = cls.clean_currency(basic)
        p = cls.clean_currency(pf)
        expected = round(b * rate, 2)
        diff = abs(p - expected)
        return diff <= tolerance, expected, diff

    @classmethod
    def validate_taxable_income(cls, gross: Any, ssnit: Any, pf: Any, taxable: Any, tolerance: float = 0.01) -> Tuple[bool, float, float]:
        """Validate Taxable Income = Gross - SSNIT - PF."""
        g = cls.clean_currency(gross)
        s = cls.clean_currency(ssnit)
        p = cls.clean_currency(pf)
        t = cls.clean_currency(taxable)
        expected = round(g - s - p, 2)
        diff = abs(t - expected)
        return diff <= tolerance, expected, diff

    @classmethod
    def compute_tax(cls, taxable_income: float, brackets: Optional[List[Tuple[float, float, float]]] = None) -> float:
        """Compute income tax using progressive brackets."""
        brackets = brackets or cls.DEFAULT_TAX_BRACKETS
        tax = 0.0
        remaining = taxable_income

        for lower, upper, rate in brackets:
            if remaining <= 0:
                break
            bracket_income = min(remaining, upper - lower)
            tax += bracket_income * rate
            remaining -= bracket_income

        return round(tax, 2)

    @classmethod
    def validate_income_tax(cls, taxable: Any, tax: Any, brackets: Optional[List[Tuple[float, float, float]]] = None, tolerance: float = 0.01) -> Tuple[bool, float, float]:
        """Validate Income Tax against computed value."""
        t = cls.clean_currency(taxable)
        actual_tax = cls.clean_currency(tax)
        expected = cls.compute_tax(t, brackets)
        diff = abs(actual_tax - expected)
        return diff <= tolerance, expected, diff

    @classmethod
    def validate_take_home(cls, gross: Any, total_deductions: Any, take_home: Any, tolerance: float = 0.01) -> Tuple[bool, float, float]:
        """Validate Take Home = Gross - Total Deductions."""
        g = cls.clean_currency(gross)
        d = cls.clean_currency(total_deductions)
        t = cls.clean_currency(take_home)
        expected = round(g - d, 2)
        diff = abs(t - expected)
        return diff <= tolerance, expected, diff

    @classmethod
    def validate_all(
        cls,
        df: pd.DataFrame,
        column_map: Dict[str, str],
        ssnit_rate: float = 0.05,
        pf_rate: float = 0.045,
        tax_brackets: Optional[List[Tuple[float, float, float]]] = None,
        tolerance: float = 0.01,
    ) -> Dict[str, Any]:
        """
        Run all validations on a DataFrame.

        column_map maps logical names to DataFrame columns:
          {
            "basic": "Basic",
            "allowance": "Allowance",
            "gross": "Gross",
            "ssnit": "SSNIT",
            "pf": "PF",
            "taxable": "Taxable Income",
            "tax": "Income Tax",
            "total_deductions": "Total Deductions",
            "take_home": "Take Home",
          }
        Only checks are run for columns that exist in the map.
        """
        results: List[Dict[str, Any]] = []
        flagged_count = 0
        validated_count = 0

        for idx, row in df.iterrows():
            row_results: Dict[str, Any] = {"row_index": int(idx), "checks": []}

            # Gross
            if all(k in column_map for k in ["basic", "allowance", "gross"]):
                try:
                    ok, expected, diff = cls.validate_gross(
                        row.get(column_map["basic"]),
                        row.get(column_map["allowance"]),
                        row.get(column_map["gross"]),
                        tolerance,
                    )
                    row_results["checks"].append({
                        "check": "gross",
                        "passed": ok,
                        "expected": expected,
                        "actual": cls.clean_currency(row.get(column_map["gross"])),
                        "difference": diff,
                        "formula": "Gross = Basic + Allowance",
                    })
                    validated_count += 1
                    if not ok:
                        flagged_count += 1
                except Exception:
                    pass

            # SSNIT
            if all(k in column_map for k in ["basic", "ssnit"]):
                try:
                    ok, expected, diff = cls.validate_ssnit(
                        row.get(column_map["basic"]),
                        row.get(column_map["ssnit"]),
                        ssnit_rate,
                        tolerance,
                    )
                    row_results["checks"].append({
                        "check": "ssnit",
                        "passed": ok,
                        "expected": expected,
                        "actual": cls.clean_currency(row.get(column_map["ssnit"])),
                        "difference": diff,
                        "formula": f"SSNIT = Basic × {ssnit_rate*100:.1f}%",
                    })
                    validated_count += 1
                    if not ok:
                        flagged_count += 1
                except Exception:
                    pass

            # PF
            if all(k in column_map for k in ["basic", "pf"]):
                try:
                    ok, expected, diff = cls.validate_pf(
                        row.get(column_map["basic"]),
                        row.get(column_map["pf"]),
                        pf_rate,
                        tolerance,
                    )
                    row_results["checks"].append({
                        "check": "pf",
                        "passed": ok,
                        "expected": expected,
                        "actual": cls.clean_currency(row.get(column_map["pf"])),
                        "difference": diff,
                        "formula": f"PF = Basic × {pf_rate*100:.1f}%",
                    })
                    validated_count += 1
                    if not ok:
                        flagged_count += 1
                except Exception:
                    pass

            # Taxable Income
            if all(k in column_map for k in ["gross", "ssnit", "pf", "taxable"]):
                try:
                    ok, expected, diff = cls.validate_taxable_income(
                        row.get(column_map["gross"]),
                        row.get(column_map["ssnit"]),
                        row.get(column_map["pf"]),
                        row.get(column_map["taxable"]),
                        tolerance,
                    )
                    row_results["checks"].append({
                        "check": "taxable_income",
                        "passed": ok,
                        "expected": expected,
                        "actual": cls.clean_currency(row.get(column_map["taxable"])),
                        "difference": diff,
                        "formula": "Taxable Income = Gross - SSNIT - PF",
                    })
                    validated_count += 1
                    if not ok:
                        flagged_count += 1
                except Exception:
                    pass

            # Income Tax
            if all(k in column_map for k in ["taxable", "tax"]):
                try:
                    ok, expected, diff = cls.validate_income_tax(
                        row.get(column_map["taxable"]),
                        row.get(column_map["tax"]),
                        tax_brackets,
                        tolerance,
                    )
                    row_results["checks"].append({
                        "check": "income_tax",
                        "passed": ok,
                        "expected": expected,
                        "actual": cls.clean_currency(row.get(column_map["tax"])),
                        "difference": diff,
                        "formula": "Progressive tax brackets",
                    })
                    validated_count += 1
                    if not ok:
                        flagged_count += 1
                except Exception:
                    pass

            # Take Home
            if all(k in column_map for k in ["gross", "total_deductions", "take_home"]):
                try:
                    ok, expected, diff = cls.validate_take_home(
                        row.get(column_map["gross"]),
                        row.get(column_map["total_deductions"]),
                        row.get(column_map["take_home"]),
                        tolerance,
                    )
                    row_results["checks"].append({
                        "check": "take_home",
                        "passed": ok,
                        "expected": expected,
                        "actual": cls.clean_currency(row.get(column_map["take_home"])),
                        "difference": diff,
                        "formula": "Take Home = Gross - Total Deductions",
                    })
                    validated_count += 1
                    if not ok:
                        flagged_count += 1
                except Exception:
                    pass

            if any(not c["passed"] for c in row_results["checks"]):
                results.append(row_results)

        summary = {
            "total_rows": len(df),
            "validated_count": validated_count,
            "flagged_rows": len(results),
            "total_checks_failed": sum(
                sum(1 for c in r["checks"] if not c["passed"])
                for r in results
            ),
            "check_breakdown": cls._check_breakdown(results),
        }

        return {"results": results, "summary": summary}

    @staticmethod
    def _check_breakdown(results: List[Dict[str, Any]]) -> Dict[str, int]:
        """Count failures per check type."""
        breakdown: Dict[str, int] = {}
        for r in results:
            for c in r["checks"]:
                if not c["passed"]:
                    breakdown[c["check"]] = breakdown.get(c["check"], 0) + 1
        return breakdown
