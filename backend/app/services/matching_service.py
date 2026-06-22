"""
Multi-field Employee Matching Engine.
Performs staged matching with confidence scoring using RapidFuzz.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional, Tuple
from dataclasses import dataclass, field

import pandas as pd
import numpy as np
from rapidfuzz import fuzz, process as fuzz_process

from app.services.cleaning_service import DataCleaningService


@dataclass
class MatchResult:
    """Result of a single employee match attempt."""
    employee_id: str
    confidence: float
    match_stage: int  # 1=exact ID, 2=multi-field, 3=manual review suggested
    matched_on: str  # description of what matched
    matched_hr_id: Optional[str] = None
    matched_hr_name: Optional[str] = None
    field_scores: Dict[str, float] = field(default_factory=dict)
    alternative_matches: List[Dict[str, Any]] = field(default_factory=list)
    manual_review: bool = False
    error: Optional[str] = None


class EmployeeMatchingEngine:
    """
    Three-stage employee matching engine:
    Stage 1: Match by Staff ID (100% confidence)
    Stage 2: If ID missing/partial, match by Name + Branch + Rank + Basic Salary
    Stage 3: Multiple possible matches → flag manual review
    """

    # Field weights for composite confidence scoring
    DEFAULT_FIELD_WEIGHTS: Dict[str, float] = {
        "name": 0.40,
        "branch": 0.15,
        "rank": 0.20,
        "grade": 0.20,
        "basic_salary": 0.25,
    }

    @staticmethod
    def _normalize_for_fuzzy(value: Any) -> str:
        """Normalize a value for fuzzy comparison."""
        if pd.isna(value) or value is None:
            return ""
        text = str(value).strip().upper()
        text = " ".join(text.split())  # collapse whitespace
        return text

    @classmethod
    def _name_similarity(cls, name1: Any, name2: Any) -> float:
        """Compute name similarity using token sort ratio."""
        n1 = cls._normalize_for_fuzzy(name1)
        n2 = cls._normalize_for_fuzzy(name2)
        if not n1 or not n2:
            return 0.0
        return fuzz.token_sort_ratio(n1, n2) / 100.0

    @classmethod
    def _text_similarity(cls, val1: Any, val2: Any) -> float:
        """Compute text similarity."""
        v1 = cls._normalize_for_fuzzy(val1)
        v2 = cls._normalize_for_fuzzy(val2)
        if not v1 or not v2:
            return 0.0
        if v1 == v2:
            return 1.0
        return fuzz.ratio(v1, v2) / 100.0

    @classmethod
    def _salary_similarity(cls, sal1: Any, sal2: Any, tolerance: float = 0.05) -> float:
        """Compute salary similarity within tolerance."""
        try:
            s1 = float(DataCleaningService.clean_currency_value(sal1))
            s2 = float(DataCleaningService.clean_currency_value(sal2))
        except (TypeError, ValueError):
            return 0.0
        if s1 == 0 and s2 == 0:
            return 1.0
        if s1 == 0 or s2 == 0:
            return 0.0
        ratio = min(s1, s2) / max(s1, s2)
        if ratio >= (1.0 - tolerance):
            return ratio
        return ratio * 0.5  # penalize if outside tolerance

    @classmethod
    def _compute_composite_score(
        cls,
        name_score: float,
        branch_score: float,
        rank_score: float,
        salary_score: float,
        weights: Optional[Dict[str, float]] = None,
    ) -> float:
        """Compute weighted composite confidence score."""
        w = weights or cls.DEFAULT_FIELD_WEIGHTS
        total_weight = sum(w.values())
        if total_weight == 0:
            return 0.0
        score = (
            name_score * w.get("name", 0.40) +
            branch_score * w.get("branch", 0.15) +
            rank_score * w.get("rank", 0.20) +
            salary_score * w.get("basic_salary", 0.25)
        )
        return min(score / total_weight, 1.0)

    @classmethod
    def stage1_match_by_id(
        cls,
        payroll_df: pd.DataFrame,
        hr_df: pd.DataFrame,
        payroll_id_col: str,
        hr_id_col: str,
        normalize_ids: bool = True,
        keep_digits: int = 5,
    ) -> Tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
        """
        Stage 1: Exact matching by Staff ID.
        Returns (matched_df, unmatched_payroll_df, unmatched_hr_df).
        """
        from app.services.comparison_service import ComparisonService

        p_df = payroll_df.copy()
        h_df = hr_df.copy()

        merge_col = "_match_id_pay"
        hr_merge_col = "_match_id_hr"
        p_df[merge_col] = ComparisonService._normalized_id_series(
            p_df[payroll_id_col], normalize_ids, keep_digits
        )
        h_df[hr_merge_col] = ComparisonService._normalized_id_series(
            h_df[hr_id_col], normalize_ids, keep_digits
        )

        # Remove empty IDs
        p_valid = p_df[p_df[merge_col] != ""].copy()
        h_valid = h_df[h_df[hr_merge_col] != ""].copy()
        p_no_id = p_df[p_df[merge_col] == ""].copy()
        h_no_id = h_df[h_df[hr_merge_col] == ""].copy()

        # Merge on ID
        matched = pd.merge(
            p_valid, h_valid,
            left_on=merge_col, right_on=hr_merge_col,
            how="inner", suffixes=("_payroll", "_hr"),
        )
        matched_ids = set(matched[merge_col].unique())

        unmatched_payroll = p_valid[~p_valid[merge_col].isin(matched_ids)].copy()
        unmatched_hr = h_valid[~h_valid[hr_merge_col].isin(matched_ids)].copy()

        # Add employees with no ID back to unmatched
        unmatched_payroll = pd.concat(
            [unmatched_payroll, p_no_id], ignore_index=True
        )
        unmatched_hr = pd.concat(
            [unmatched_hr, h_no_id], ignore_index=True
        )

        # Drop merge columns
        for df in [matched, unmatched_payroll, unmatched_hr]:
            for col in [merge_col, hr_merge_col]:
                if col in df.columns:
                    df.drop(columns=[col], inplace=True)

        return matched, unmatched_payroll, unmatched_hr

    @classmethod
    def stage2_match_by_fields(
        cls,
        unmatched_payroll: pd.DataFrame,
        unmatched_hr: pd.DataFrame,
        payroll_name_col: Optional[str] = None,
        hr_name_col: Optional[str] = None,
        payroll_branch_col: Optional[str] = None,
        hr_branch_col: Optional[str] = None,
        payroll_rank_col: Optional[str] = None,
        hr_rank_col: Optional[str] = None,
        payroll_grade_col: Optional[str] = None,
        hr_grade_col: Optional[str] = None,
        payroll_salary_col: Optional[str] = None,
        hr_salary_col: Optional[str] = None,
        min_confidence: float = 0.75,
        threshold_manual_review: float = 0.60,
        top_n_candidates: int = 3,
    ) -> Dict[str, Any]:
        """
        Stage 2: Match unmatched employees using Name, Branch, Rank, Salary.
        Stage 3: Flag for manual review if multiple candidates are close.

        Returns dict with:
          - matches: List[MatchResult] for high-confidence matches
          - manual_review: List[MatchResult] for ambiguous matches
          - still_unmatched_payroll: indices still unmatched
          - still_unmatched_hr: indices still unmatched
        """
        if unmatched_payroll.empty or unmatched_hr.empty:
            return {
                "matches": [],
                "manual_review": [],
                "still_unmatched_payroll": unmatched_payroll.index.tolist(),
                "still_unmatched_hr": unmatched_hr.index.tolist(),
                "matched_payroll_indices": [],
                "matched_hr_indices": [],
            }

        matches: List[MatchResult] = []
        manual_review: List[MatchResult] = []
        matched_payroll_indices: List[int] = []
        matched_hr_indices: List[int] = []

        # Pre-compute HR candidates list for fuzzy matching
        hr_candidates: List[Dict[str, Any]] = []
        for hr_idx, hr_row in unmatched_hr.iterrows():
            candidate = {
                "index": hr_idx,
                "name": cls._normalize_for_fuzzy(
                    hr_row.get(hr_name_col) if hr_name_col else None
                ),
                "branch": cls._normalize_for_fuzzy(
                    hr_row.get(hr_branch_col) if hr_branch_col else None
                ),
                "rank": cls._normalize_for_fuzzy(
                    hr_row.get(hr_rank_col) if hr_rank_col else None
                ),
                "grade": cls._normalize_for_fuzzy(
                    hr_row.get(hr_grade_col) if hr_grade_col else None
                ),
                "salary": hr_row.get(hr_salary_col) if hr_salary_col else None,
            }
            hr_candidates.append(candidate)

        used_hr_indices: set = set()

        for p_idx, p_row in unmatched_payroll.iterrows():
            p_name = cls._normalize_for_fuzzy(
                p_row.get(payroll_name_col) if payroll_name_col else None
            )
            p_branch = cls._normalize_for_fuzzy(
                p_row.get(payroll_branch_col) if payroll_branch_col else None
            )
            p_rank = cls._normalize_for_fuzzy(
                p_row.get(payroll_rank_col) if payroll_rank_col else None
            )
            p_grade = cls._normalize_for_fuzzy(
                p_row.get(payroll_grade_col) if payroll_grade_col else None
            )
            p_salary = p_row.get(payroll_salary_col) if payroll_salary_col else None

            if not p_name and not p_salary:
                continue  # not enough to match

            # Score each HR candidate
            scored_candidates: List[Dict[str, Any]] = []
            for hc in hr_candidates:
                if hc["index"] in used_hr_indices:
                    continue

                name_score = cls._name_similarity(p_name, hc["name"]) if p_name and hc["name"] else 0.0
                branch_score = cls._text_similarity(p_branch, hc["branch"]) if p_branch and hc["branch"] else 0.0
                rank_score = cls._text_similarity(p_rank, hc["rank"]) if p_rank and hc["rank"] else 0.0
                # Combine rank+grade as rank score if both available
                if p_grade and hc["grade"]:
                    grade_score = cls._text_similarity(p_grade, hc["grade"])
                    rank_score = max(rank_score, grade_score) if rank_score > 0 else grade_score
                salary_score = cls._salary_similarity(p_salary, hc["salary"]) if p_salary is not None and hc["salary"] is not None else 0.0

                composite = cls._compute_composite_score(
                    name_score, branch_score, rank_score, salary_score
                )

                scored_candidates.append({
                    "hr_index": hc["index"],
                    "hr_name": hc["name"],
                    "confidence": composite,
                    "field_scores": {
                        "name": name_score,
                        "branch": branch_score,
                        "rank": rank_score,
                        "salary": salary_score,
                    },
                })

            if not scored_candidates:
                continue

            # Sort by confidence descending
            scored_candidates.sort(key=lambda x: x["confidence"], reverse=True)
            best = scored_candidates[0]

            if best["confidence"] >= min_confidence:
                # High-confidence match - Stage 2
                matched_hr_idx = best["hr_index"]
                used_hr_indices.add(matched_hr_idx)
                matched_payroll_indices.append(p_idx)
                matched_hr_indices.append(matched_hr_idx)

                matches.append(MatchResult(
                    employee_id=str(p_row.get(payroll_name_col if payroll_name_col else p_idx, p_idx)),
                    confidence=best["confidence"],
                    match_stage=2,
                    matched_on=f"Multi-field match ({best['confidence']:.0%})",
                    matched_hr_id=str(unmatched_hr.loc[matched_hr_idx].get(
                        hr_name_col if hr_name_col else "index", matched_hr_idx
                    )),
                    field_scores=best["field_scores"],
                    alternative_matches=[
                        {"hr_index": c["hr_index"], "confidence": c["confidence"]}
                        for c in scored_candidates[1:top_n_candidates]
                        if c["confidence"] > threshold_manual_review
                    ],
                ))

            elif best["confidence"] >= threshold_manual_review:
                # Ambiguous - Stage 3 manual review
                close_candidates = [
                    c for c in scored_candidates[:top_n_candidates]
                    if c["confidence"] > threshold_manual_review and
                    c["confidence"] >= best["confidence"] * 0.85
                ]

                manual_review.append(MatchResult(
                    employee_id=str(p_row.get(payroll_name_col if payroll_name_col else p_idx, p_idx)),
                    confidence=best["confidence"],
                    match_stage=3,
                    matched_on=f"Multiple possible matches (best: {best['confidence']:.0%})",
                    field_scores=best["field_scores"],
                    alternative_matches=[
                        {
                            "hr_index": c["hr_index"],
                            "confidence": c["confidence"],
                            "hr_name": c["hr_name"],
                        }
                        for c in close_candidates
                    ],
                    manual_review=True,
                ))

        still_unmatched_payroll_indices = [
            idx for idx in unmatched_payroll.index
            if idx not in matched_payroll_indices
        ]
        still_unmatched_hr_indices = [
            idx for idx in unmatched_hr.index
            if idx not in matched_hr_indices
        ]

        return {
            "matches": matches,
            "manual_review": manual_review,
            "matched_payroll_indices": matched_payroll_indices,
            "matched_hr_indices": matched_hr_indices,
            "still_unmatched_payroll": still_unmatched_payroll_indices,
            "still_unmatched_hr": still_unmatched_hr_indices,
        }

    @classmethod
    def full_matching_pipeline(
        cls,
        payroll_df: pd.DataFrame,
        hr_df: pd.DataFrame,
        payroll_id_col: Optional[str] = None,
        hr_id_col: Optional[str] = None,
        payroll_name_col: Optional[str] = None,
        hr_name_col: Optional[str] = None,
        payroll_branch_col: Optional[str] = None,
        hr_branch_col: Optional[str] = None,
        payroll_rank_col: Optional[str] = None,
        hr_rank_col: Optional[str] = None,
        payroll_grade_col: Optional[str] = None,
        hr_grade_col: Optional[str] = None,
        payroll_salary_col: Optional[str] = None,
        hr_salary_col: Optional[str] = None,
        min_confidence: float = 0.75,
        threshold_manual_review: float = 0.60,
        normalize_ids: bool = True,
        keep_digits: int = 5,
    ) -> Dict[str, Any]:
        """
        Run the full 3-stage matching pipeline:
        1. Match by ID
        2. Multi-field fuzzy match for unmatched
        3. Flag ambiguous matches for manual review
        """
        result: Dict[str, Any] = {
            "stage1": {"matched": 0, "total_payroll": len(payroll_df), "total_hr": len(hr_df)},
            "stage2": {"matched": 0},
            "stage3": {"manual_review": 0},
            "stage1_matched_df": pd.DataFrame(),
            "stage2_matches": [],
            "stage3_manual_review": [],
            "still_unmatched_payroll_count": 0,
            "still_unmatched_hr_count": 0,
            "summary": {},
        }

        # Stage 1: ID matching
        if payroll_id_col and hr_id_col:
            matched_df, unmatched_payroll, unmatched_hr = cls.stage1_match_by_id(
                payroll_df, hr_df, payroll_id_col, hr_id_col,
                normalize_ids, keep_digits,
            )
            result["stage1"]["matched"] = len(matched_df)
            result["stage1"]["matched_df"] = matched_df
            result["stage1"]["unmatched_payroll"] = unmatched_payroll
            result["stage1"]["unmatched_hr"] = unmatched_hr
        else:
            unmatched_payroll = payroll_df.copy()
            unmatched_hr = hr_df.copy()

        # Stage 2 & 3: Multi-field matching for unmatched
        if not unmatched_payroll.empty and not unmatched_hr.empty:
            stage2_result = cls.stage2_match_by_fields(
                unmatched_payroll, unmatched_hr,
                payroll_name_col=payroll_name_col,
                hr_name_col=hr_name_col,
                payroll_branch_col=payroll_branch_col,
                hr_branch_col=hr_branch_col,
                payroll_rank_col=payroll_rank_col,
                hr_rank_col=hr_rank_col,
                payroll_grade_col=payroll_grade_col,
                hr_grade_col=hr_grade_col,
                payroll_salary_col=payroll_salary_col,
                hr_salary_col=hr_salary_col,
                min_confidence=min_confidence,
                threshold_manual_review=threshold_manual_review,
            )
            result["stage2"]["matched"] = len(stage2_result["matches"])
            result["stage2"]["matches"] = [m.__dict__ for m in stage2_result["matches"]]
            result["stage3"]["manual_review"] = len(stage2_result["manual_review"])
            result["stage3"]["manual_review_list"] = [m.__dict__ for m in stage2_result["manual_review"]]
            result["still_unmatched_payroll_indices"] = stage2_result["still_unmatched_payroll"]
            result["still_unmatched_hr_indices"] = stage2_result["still_unmatched_hr"]
            result["matched_payroll_indices_stage2"] = stage2_result["matched_payroll_indices"]
            result["matched_hr_indices_stage2"] = stage2_result["matched_hr_indices"]
        else:
            result["still_unmatched_payroll_indices"] = unmatched_payroll.index.tolist() if not unmatched_payroll.empty else []
            result["still_unmatched_hr_indices"] = unmatched_hr.index.tolist() if not unmatched_hr.empty else []

        result["still_unmatched_payroll_count"] = len(result["still_unmatched_payroll_indices"])
        result["still_unmatched_hr_count"] = len(result["still_unmatched_hr_indices"])

        total_matched = result["stage1"]["matched"] + result["stage2"]["matched"]
        total_review = result["stage3"]["manual_review"]

        result["summary"] = {
            "total_payroll_records": len(payroll_df),
            "total_hr_records": len(hr_df),
            "stage1_id_matched": result["stage1"]["matched"],
            "stage2_fuzzy_matched": result["stage2"]["matched"],
            "total_matched": total_matched,
            "stage3_manual_review_needed": total_review,
            "still_unmatched_payroll": result["still_unmatched_payroll_count"],
            "still_unmatched_hr": result["still_unmatched_hr_count"],
            "match_rate": round(total_matched / max(len(payroll_df), 1) * 100, 1),
        }

        return result
