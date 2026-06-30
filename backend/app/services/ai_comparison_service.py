from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

import pandas as pd
from langchain_ollama import ChatOllama
from langchain_core.messages import HumanMessage, SystemMessage

from app.config import OLLAMA_MODEL, OLLAMA_BASE_URL

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────

OLLAMA_TIMEOUT = 180          # seconds — generous for larger local models
MAX_MISMATCH_ROWS = 60        # rows sent to model; trimmed to protect context window
TOKEN_LIMIT_ESTIMATE = 7_000  # rough token ceiling (~4 chars per token)

# ---------------------------------------------------------------------------
# System prompt — deep Ghanaian payroll domain context
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """
You are a senior payroll auditor specialising in Ghanaian public and private sector
payroll reconciliation. You have deep knowledge of:

STATUTORY DEDUCTIONS (Ghana):
- SSNIT Tier 1: 13.5% of basic salary (employer contribution).
- SSNIT Tier 2 (MOP): 5% of basic salary (employer contribution, goes to occupational pension fund).
- SSF Employee (5.5%): employee's Social Security Fund contribution.
- SSF Employer (13%): employer's Social Security Fund contribution.
- Provident Fund Employee (5%): staff voluntary PF contribution.
- Provident Fund Employer (7.5%): employer PF contribution.
- Total PF (12%): sum of employee 5% + employer 7.5%.
- Income Tax / PAYE: Ghana Revenue Authority graduated tax bands:
    0% on first GHS 402/month, 5% on next GHS 110, 10% on next GHS 130,
    17.5% on next GHS 3,000, 25% on next GHS 16,000, 30% on next GHS 80,000,
    35% on excess above GHS 99,772/month (figures subject to GRA annual revision).
- 3% ICU/PMSU: Industrial & Commercial Workers Union or Public & Municipal Services Union dues.
- Welfare Dues: union/staff welfare fund deduction.
- Tax Relief: personal and/or marriage relief applied before PAYE calculation.
- Taxable Income: Annual Salary minus applicable reliefs, used as base for PAYE.

ALLOWANCES (common in Ghanaian payroll):
Transportation, Enhancement, Furnishing, Rent, Vehicle & Fuel, Car Maintenance,
Security, Signing Allowance, Utility, Responsibility, Risk, Lunch, General Manager
Driver Allowance, Entertainment, Acting Allowance, Motorbike Fuel, Motor Maintenance.

CROSS-FIELD RULES YOU MUST ENFORCE:
1. Net Pay = Basic Salary + Total Allowance - SSF Employee (5.5%) - Total PF Employee (5%)
   - ICU/PMSU (3%) - Welfare Dues - Income Tax (PAYE). Flag if Net Pay deviates
   by more than GHS 1 from this formula.
2. TIER 1 (13.5%) and TIER 2 MOP (5%) are EMPLOYER costs — they must NOT appear
   as deductions from Net Pay. Flag any case where Net Pay has been reduced by these.
3. Annual Salary / 12 should equal Basic Salary (monthly). Flag discrepancies > GHS 1.
4. NEW BASIC should match Basic Salary unless there is an active salary review —
   flag any unexplained difference.
5. 16% column typically represents 16% of Basic (possibly a special allowance or
   contribution). Flag if value is inconsistent with 16% × Basic.
6. Total Allowance must equal the sum of all individual allowance columns.
   Flag any mismatch > GHS 1.
7. Taxable Income = Annual Salary - Tax Relief (annualised). Flag deviations.
8. PAYE must correspond to the correct GRA tax band for the Taxable Income.
   Flag any employee whose PAYE appears too low or too high for their income band.
9. SSF Employee (5.5%) = 5.5% × Basic Salary. Flag deviations > GHS 1.
10. Total PF (12%) = Employee PF (5%) + Employer PF (7.5%). Flag if these do not sum.

YOUR TASK:
Analyse the supplied payroll comparison payload — which contrasts two payroll runs
or two files — and identify ALL of the following:
  A. Employees present in one file but missing in the other (joiners / leavers / ID mismatches).
  B. Salary or allowance changes that are unusually large (>20% shift with no explanation).
  C. Statutory deduction amounts that violate the cross-field rules above.
  D. PAYE amounts inconsistent with GRA tax bands for the declared taxable income.
  E. Net Pay figures that do not reconcile with the formula in rule 1 above.
  F. Duplicate employee IDs or account numbers within either file.
  G. Name mismatches for the same ID (possible data entry errors or fraud signals).
  H. Zero or blank values in critical fields (Basic Salary, Net Pay, Account Number).
  I. Negative values in fields that must always be positive (Net Pay, SSNIT contributions).
  J. Allowances that changed between runs without a corresponding salary change.

STRICT OUTPUT RULES:
- Return ONLY valid JSON. No preamble, no explanation outside the JSON, no markdown fences.
- Every "evidence" field must quote actual values, field names, employee identifiers,
  or amounts from the payload. Do NOT invent figures, names, or causes.
- Do NOT speculate about why a difference exists — only report what the data shows.
- If a finding cannot be supported by specific data in the payload, omit it entirely.
- If there are no issues in a category, omit that category from key_findings.
- Be specific: "Employee A123 Net Pay changed from GHS 4,200 to GHS 3,950 (-GHS 250)"
  is a finding. "Some employees had Net Pay changes" is not.
"""

# ---------------------------------------------------------------------------
# Human prompt template
# ---------------------------------------------------------------------------
HUMAN_PROMPT_TEMPLATE = """
Analyse the payroll comparison payload below and return a JSON object with exactly
this shape — no extra keys, no missing keys:

{{
  "executive_summary": "2-4 sentences. State total employees compared, how many had
    differences, overall risk level, and the single most critical finding. Be specific
    with numbers.",

  "risk_level": "low | medium | high | critical",

  "key_findings": [
    {{
      "category": "one of: net_pay | paye | ssnit | provident_fund | allowances |
        presence | duplicates | names | account_numbers | salary | cross_field | data_quality",
      "severity": "low | medium | high | critical",
      "finding": "Precise description of the issue. Name specific employees or IDs
        where possible. Quote before/after amounts.",
      "evidence": "Exact values, field names, row counts, or amounts from the payload
        that support this finding. If quoting an amount, include the currency (GHS).",
      "affected_count": <integer — number of employees or rows affected, or 0 if unknown>,
      "recommended_action": "One specific, actionable next step for the HR/payroll team."
    }}
  ],

  "statutory_compliance": {{
    "ssnit_ok": <true | false — are all SSNIT Tier 1 and Tier 2 amounts consistent?>,
    "paye_ok": <true | false — do all PAYE amounts appear consistent with GRA bands?>,
    "net_pay_ok": <true | false — do all Net Pay figures reconcile with the formula?>,
    "ssf_ok": <true | false — are all SSF employee deductions correct at 5.5%?>,
    "notes": "Any statutory compliance observations not captured in key_findings."
  }},

  "recommended_actions": [
    "Prioritised list of next steps for the payroll team before uploading to the HR system.
     Each item should be specific and actionable, referencing actual findings above."
  ]
}}

{sample_note}

Comparison payload:
{payload}
"""


# ──────────────────────────────────────────────
# Service
# ──────────────────────────────────────────────

class AIComparisonService:
    """Generate narrative inconsistency reports from deterministic comparison output."""

    # ── helpers ──────────────────────────────────────────────────────────────

    @staticmethod
    def _records(df: Optional[pd.DataFrame], limit: int) -> List[Dict[str, Any]]:
        if df is None or len(df) == 0:
            return []
        return df.head(limit).to_dict("records")

    @staticmethod
    def _total_rows(df: Optional[pd.DataFrame]) -> int:
        if df is None:
            return 0
        return len(df)

    @staticmethod
    def _extract_json(text: str) -> Dict[str, Any]:
        """Extract a JSON object from model output, stripping any markdown fences."""
        if not text or not text.strip():
            raise ValueError("AI model returned an empty response.")

        # strip fenced code blocks
        fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        candidate = fenced.group(1) if fenced else text.strip()

        # find outermost { ... } if model added preamble
        if not candidate.startswith("{"):
            start = candidate.find("{")
            end = candidate.rfind("}")
            if start >= 0 and end > start:
                candidate = candidate[start : end + 1]
            else:
                raise ValueError(f"No JSON object found in model output:\n{text[:500]}")

        try:
            return json.loads(candidate)
        except json.JSONDecodeError as exc:
            raise ValueError(f"Model output is not valid JSON: {exc}\nRaw output:\n{candidate[:500]}")

    @staticmethod
    def _estimate_tokens(text: str) -> int:
        """Rough token estimate: ~4 characters per token."""
        return len(text) // 4

    # ── fallback reports ─────────────────────────────────────────────────────

    @staticmethod
    def _fallback_report(reason: str) -> Dict[str, Any]:
        logger.warning("AI validation unavailable: %s", reason)
        return {
            "enabled": True,
            "available": False,
            "model": OLLAMA_MODEL,
            "warning": reason,
            "executive_summary": (
                "The rule-based payroll comparison completed successfully, but the AI "
                "explanation layer was unavailable. Review the structured comparison "
                "results directly."
            ),
            "risk_level": "unknown",
            "statutory_compliance": {
                "ssnit_ok": None,
                "paye_ok": None,
                "net_pay_ok": None,
                "ssf_ok": None,
                "notes": "AI layer unavailable — statutory checks not performed.",
            },
            "key_findings": [],
            "recommended_actions": [
                f"Ensure Ollama is running: `ollama serve`",
                f"Ensure the model is available: `ollama pull {OLLAMA_MODEL}`",
                "Retry the AI audit once Ollama is confirmed running.",
            ],
        }

    @staticmethod
    def _no_match_report(comparison_result: Dict[str, Any]) -> Dict[str, Any]:
        total_f1 = comparison_result.get("total_file1", 0) or 0
        total_f2 = comparison_result.get("total_file2", 0) or 0
        logger.warning(
            "No employee records matched. file1=%d, file2=%d", total_f1, total_f2
        )
        return {
            "enabled": True,
            "available": True,
            "model": OLLAMA_MODEL,
            "executive_summary": (
                f"No employees could be matched between the two files "
                f"(File 1: {total_f1} records, File 2: {total_f2} records). "
                "This is a matching-key configuration problem, not a sign the files "
                "are identical or empty. All findings below are blocked until matching "
                "is resolved."
            ),
            "risk_level": "critical",
            "statutory_compliance": {
                "ssnit_ok": None,
                "paye_ok": None,
                "net_pay_ok": None,
                "ssf_ok": None,
                "notes": "Cannot perform statutory checks — no records matched.",
            },
            "key_findings": [
                {
                    "category": "presence",
                    "severity": "critical",
                    "finding": (
                        "Zero employee records matched across the two files. "
                        "All comparison and audit checks are blocked."
                    ),
                    "evidence": (
                        f"matched=0, total_file1={total_f1}, total_file2={total_f2}. "
                        "The selected identifier column(s) produced no overlapping values."
                    ),
                    "affected_count": max(total_f1, total_f2),
                    "recommended_action": (
                        "Re-select the matching key. If Staff ID is blank in either file, "
                        "try Account Number or SSNIT number. Ensure the identifier column "
                        "contains real, consistent values in both files before re-running."
                    ),
                }
            ],
            "recommended_actions": [
                "Select an identifier column that contains real values in both files.",
                "If Staff ID is unreliable, use Account Number or SSNIT Number.",
                "Check that both files cover the same pay period and staff population.",
            ],
        }

    # ── payload builder ───────────────────────────────────────────────────────

    @classmethod
    def build_payload(
        cls, comparison_result: Dict[str, Any]
    ) -> tuple[Dict[str, Any], str]:
        """
        Build the data payload sent to the model and a sample note explaining
        any trimming applied to protect the context window.
        """
        total_mismatches = cls._total_rows(comparison_result.get("mismatches_df"))
        mismatch_sample = cls._records(
            comparison_result.get("mismatches_df"), MAX_MISMATCH_ROWS
        )

        sample_note = (
            f"NOTE: The top_mismatches list is a representative sample of "
            f"{len(mismatch_sample)} rows out of {total_mismatches} total mismatched "
            f"records. Base your 'affected_count' on the summary counts, not the sample size."
            if total_mismatches > MAX_MISMATCH_ROWS
            else ""
        )

        payload: Dict[str, Any] = {
            "summary": {
                "total_file1": comparison_result.get("total_file1"),
                "total_file2": comparison_result.get("total_file2"),
                "matched": comparison_result.get("matched"),
                "only_in_file1": comparison_result.get("only_in_file1"),
                "only_in_file2": comparison_result.get("only_in_file2"),
                "employees_with_differences": comparison_result.get(
                    "employees_with_differences"
                ),
                "employees_without_differences": comparison_result.get(
                    "employees_without_differences"
                ),
                "field_differences": comparison_result.get("field_differences"),
                "duplicate_ids_file1": comparison_result.get("duplicate_ids_file1"),
                "duplicate_ids_file2": comparison_result.get("duplicate_ids_file2"),
                "total_mismatched_rows": total_mismatches,
            },
            "analytics": comparison_result.get("analytics", {}),
            "duplicate_id_samples": {
                "file1": (comparison_result.get("duplicate_id_samples_file1") or [])[:20],
                "file2": (comparison_result.get("duplicate_id_samples_file2") or [])[:20],
            },
            "presence_preview": {
                "only_in_file1": (comparison_result.get("only_in_file1_preview") or [])[:20],
                "only_in_file2": (comparison_result.get("only_in_file2_preview") or [])[:20],
            },
            "top_mismatches": mismatch_sample,
        }

        # Trim payload further if it still exceeds token budget
        payload_str = json.dumps(payload, default=str)
        if cls._estimate_tokens(payload_str) > TOKEN_LIMIT_ESTIMATE:
            logger.warning(
                "Payload too large (~%d tokens). Trimming top_mismatches to 30 rows.",
                cls._estimate_tokens(payload_str),
            )
            payload["top_mismatches"] = mismatch_sample[:30]
            sample_note = (
                f"NOTE: Payload was trimmed for context window. Showing 30 of "
                f"{total_mismatches} mismatched rows. Use summary counts for totals."
            )

        return payload, sample_note

    # ── main entry point ──────────────────────────────────────────────────────

    @classmethod
    def generate_audit(cls, comparison_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Run the AI audit against a payroll comparison result.

        Returns a structured dict with:
          - executive_summary
          - risk_level
          - key_findings  (with per-finding recommended_action)
          - statutory_compliance
          - recommended_actions  (prioritised list)
        """
        # Guard: nothing matched — return a meaningful no-match report immediately
        matched = int(comparison_result.get("matched", 0) or 0)
        total_f1 = int(comparison_result.get("total_file1", 0) or 0)
        total_f2 = int(comparison_result.get("total_file2", 0) or 0)

        if matched == 0 and (total_f1 > 0 or total_f2 > 0):
            return cls._no_match_report(comparison_result)

        # Build payload
        try:
            payload, sample_note = cls.build_payload(comparison_result)
        except Exception as exc:
            logger.error("Failed to build AI audit payload: %s", exc, exc_info=True)
            return cls._fallback_report(f"Payload build error: {exc}")

        # Assemble prompt
        human_prompt = HUMAN_PROMPT_TEMPLATE.format(
            sample_note=sample_note,
            payload=json.dumps(payload, indent=2, default=str),
        )

        # Invoke model
        try:
            llm = ChatOllama(
                model=OLLAMA_MODEL,
                base_url=OLLAMA_BASE_URL,
                temperature=0,
                format="json",
                num_ctx=16384,
                timeout=OLLAMA_TIMEOUT,
            )
            response = llm.invoke(
                [
                    SystemMessage(content=SYSTEM_PROMPT),
                    HumanMessage(content=human_prompt),
                ]
            )
            raw_content = getattr(response, "content", None) or str(response)

        except TimeoutError:
            return cls._fallback_report(
                f"Ollama request timed out after {OLLAMA_TIMEOUT}s. "
                "The model may be overloaded or the payload too large."
            )
        except ConnectionError as exc:
            return cls._fallback_report(
                f"Could not connect to Ollama at {OLLAMA_BASE_URL}: {exc}"
            )
        except Exception as exc:
            logger.error(
                "Unexpected error calling Ollama [%s]: %s",
                type(exc).__name__,
                exc,
                exc_info=True,
            )
            return cls._fallback_report(f"{type(exc).__name__}: {exc}")

        # Parse response
        try:
            parsed = cls._extract_json(raw_content)
        except ValueError as exc:
            logger.error("JSON extraction failed: %s", exc)
            return cls._fallback_report(
                f"Model returned unparseable output: {exc}"
            )

        # Validate required top-level keys are present
        required_keys = {
            "executive_summary", "risk_level", "key_findings",
            "statutory_compliance", "recommended_actions",
        }
        missing_keys = required_keys - set(parsed.keys())
        if missing_keys:
            logger.warning("Model response missing keys: %s", missing_keys)
            # Fill in missing keys with safe defaults rather than failing entirely
            parsed.setdefault("executive_summary", "AI summary unavailable.")
            parsed.setdefault("risk_level", "unknown")
            parsed.setdefault("key_findings", [])
            parsed.setdefault("statutory_compliance", {
                "ssnit_ok": None, "paye_ok": None,
                "net_pay_ok": None, "ssf_ok": None, "notes": "",
            })
            parsed.setdefault("recommended_actions", [])

        return {
            "enabled": True,
            "available": True,
            "model": OLLAMA_MODEL,
            "executive_summary": parsed.get("executive_summary", ""),
            "risk_level": parsed.get("risk_level", "unknown"),
            "key_findings": parsed.get("key_findings", []),
            "statutory_compliance": parsed.get("statutory_compliance", {}),
            "recommended_actions": parsed.get("recommended_actions", []),
        }