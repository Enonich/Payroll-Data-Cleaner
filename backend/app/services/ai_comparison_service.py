from __future__ import annotations

import json
import logging
import re
from typing import Any, Dict, List, Optional

import pandas as pd
from langchain_ollama import ChatOllama
from langchain_core.messages import HumanMessage, SystemMessage

from app.config import OLLAMA_MODEL, OLLAMA_BASE_URL, PAYE_BANDS_MONTHLY
from app.services.deterministic_audit_service import DeterministicAuditService

logger = logging.getLogger(__name__)

# ──────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────

OLLAMA_TIMEOUT = 180          # seconds — generous for larger local models
MAX_MISMATCH_ROWS = 60        # rows sent to model; trimmed to protect context window
TOKEN_LIMIT_ESTIMATE = 7_000  # rough token ceiling (~4 chars per token)

# ---------------------------------------------------------------------------
# System prompt — focused Explanation Engine role
#
# Architecture note (AI_Int_Issues.md):
#   "Let code discover the facts, and let the LLM explain, prioritise, and
#    guide the user through those facts."
#
# The deterministic audit service pre-computes every violation with full
# evidence.  The AI's job is ONLY to:
#   1. Explain each pre-computed violation in plain language.
#   2. Assign/confirm severity and add a recommended action where missing.
#   3. Synthesise an executive summary and risk level.
#   4. Note any patterns or correlations across findings.
#
# The AI must NOT re-compute calculations, search for new issues, or
# speculate beyond what the evidence packs show.
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """
You are a senior payroll auditor specialising in Ghanaian public and private sector
payroll. Your role in this system is that of an EXPLANATION ENGINE — not a detector.

Our audit engine has already run all deterministic checks (duplicate detection,
formula validation, presence checks, rate verification) and produced structured
evidence packs for every violation it found.

Your task is to:
1. Transform each evidence pack into a clear, plain-language finding for the
   payroll officer reviewing the data.
2. Confirm or refine the severity of each finding based on its context.
3. Provide a specific, actionable recommended_action for the payroll team.
4. Write a concise executive summary that synthesises all findings.
5. Assign an overall risk_level (low | medium | high | critical).
6. Note any patterns or correlations across findings (e.g. "allowance changes
   coincide with the same employees as the large salary changes").

STRICT RULES:
- Base every finding ONLY on the evidence packs provided — do NOT invent new issues.
- Quote actual values, employee IDs, and field names from the evidence.
- Do NOT re-calculate formulas — the evidence packs already contain the computed
  expected/actual values.
- Do NOT speculate about causes not supported by the evidence.
- If two evidence packs describe the same employees, note the correlation but
  count them as separate findings.
- Omit the statutory_compliance fields only if you have no evidence from the
  packs to populate them; otherwise set them based on the evidence provided.
"""

# ---------------------------------------------------------------------------
# Human prompt template — receives pre-computed evidence packs
# ---------------------------------------------------------------------------
HUMAN_PROMPT_TEMPLATE = """
You are receiving the output of our deterministic payroll audit engine.
All violations below have confidence = 100 (computed by Python, not guessed).
Your task is to explain each finding and produce a structured JSON report.

Return ONLY valid JSON with exactly this shape — no preamble, no markdown fences:

{{
  "executive_summary": "2-4 sentences. State total employees compared, how many had
    differences, overall risk level, and the single most critical finding. Reference
    specific numbers from the evidence packs.",

  "risk_level": "low | medium | high | critical",

  "key_findings": [
    {{
      "category": "one of: net_pay | paye | ssnit | provident_fund | allowances |
        presence | duplicates | names | account_numbers | salary | cross_field | data_quality",
      "severity": "low | medium | high | critical",
      "confidence": <integer 0-100 — use the confidence from the evidence pack, or your
        own assessment for any observation you add>,
      "finding": "Plain-language explanation of this issue for the payroll officer.
        Name specific employees or IDs where possible. Quote before/after amounts.",
      "evidence": "Exact values, field names, row counts, or amounts from the evidence
        pack that support this finding. Always include GHS currency where applicable.",
      "affected_count": <integer — number of employees or rows affected>,
      "recommended_action": "One specific, actionable next step referencing the evidence."
    }}
  ],

  "statutory_compliance": {{
    "ssnit_ok": <true | false | null — null if no SSF/SSNIT evidence was provided>,
    "paye_ok": <true | false | null — null if no PAYE evidence was provided>,
    "net_pay_ok": <true | false | null — null if no net-pay evidence was provided>,
    "ssf_ok": <true | false | null — null if no SSF-rate evidence was provided>,
    "notes": "Any statutory compliance observations from the evidence packs."
  }},

  "recommended_actions": [
    "Prioritised list of next steps for the payroll team, each referencing specific
     findings above. Most critical actions first."
  ]
}}

{sample_note}

Current PAYE bands (GRA — injected from application config, not hardcoded):
{paye_bands}

Comparison summary:
{comparison_summary}

Pre-computed evidence packs (violations found by Python audit engine):
{evidence_packs}

Additional mismatch data:
{additional_payload}
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
    ) -> tuple[Dict[str, Any], str, List[Dict[str, Any]]]:
        """
        Build the data payload sent to the model.

        Returns:
          - additional_payload: summary + analytics + mismatch sample (context window trimmed)
          - sample_note: string explaining any trimming applied
          - evidence_packs: pre-computed violations from DeterministicAuditService
        """
        # 1. Run deterministic checks first — these are facts, not guesses
        evidence_packs = DeterministicAuditService.build_evidence_packs(comparison_result)

        # 2. Build the supporting context payload (summary + analytics + mismatch sample)
        total_mismatches = cls._total_rows(comparison_result.get("mismatches_df"))
        mismatch_sample = cls._records(
            comparison_result.get("mismatches_df"), MAX_MISMATCH_ROWS
        )

        sample_note = (
            f"NOTE: The additional_mismatches list shows {len(mismatch_sample)} of "
            f"{total_mismatches} total mismatched rows. Use summary counts for totals."
            if total_mismatches > MAX_MISMATCH_ROWS
            else ""
        )

        additional_payload: Dict[str, Any] = {
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

        # Trim mismatch sample if combined payload is too large
        payload_str = json.dumps(additional_payload, default=str)
        if cls._estimate_tokens(payload_str) > TOKEN_LIMIT_ESTIMATE:
            logger.warning(
                "Payload too large (~%d tokens). Trimming top_mismatches to 30 rows.",
                cls._estimate_tokens(payload_str),
            )
            additional_payload["top_mismatches"] = mismatch_sample[:30]
            sample_note = (
                f"NOTE: Payload trimmed for context window. Showing 30 of "
                f"{total_mismatches} mismatched rows."
            )

        return additional_payload, sample_note, evidence_packs

    # ── main entry point ──────────────────────────────────────────────────────

    @classmethod
    def generate_audit(cls, comparison_result: Dict[str, Any]) -> Dict[str, Any]:
        """
        Run the AI audit against a payroll comparison result.

        Architecture:
          1. DeterministicAuditService pre-computes all violations (Python, 100% reliable).
          2. Evidence packs + PAYE bands are injected into the prompt.
          3. AI only explains and synthesises — it does not search for issues.

        Returns a structured dict with:
          - executive_summary, risk_level, key_findings (with confidence + recommended_action),
            statutory_compliance, recommended_actions
          - deterministic_violations: raw evidence packs for downstream use
        """
        matched = int(comparison_result.get("matched", 0) or 0)
        total_f1 = int(comparison_result.get("total_file1", 0) or 0)
        total_f2 = int(comparison_result.get("total_file2", 0) or 0)

        if matched == 0 and (total_f1 > 0 or total_f2 > 0):
            return cls._no_match_report(comparison_result)

        # Build payload (runs deterministic checks first)
        try:
            additional_payload, sample_note, evidence_packs = cls.build_payload(comparison_result)
        except Exception as exc:
            logger.error("Failed to build AI audit payload: %s", exc, exc_info=True)
            return cls._fallback_report(f"Payload build error: {exc}")

        # Comparison summary (small, always sent)
        comparison_summary = {
            "total_file1": total_f1,
            "total_file2": total_f2,
            "matched": matched,
            "only_in_file1": comparison_result.get("only_in_file1"),
            "only_in_file2": comparison_result.get("only_in_file2"),
            "employees_with_differences": comparison_result.get("employees_with_differences"),
            "employees_without_differences": comparison_result.get("employees_without_differences"),
            "field_differences": comparison_result.get("field_differences"),
            "duplicate_ids_file1": comparison_result.get("duplicate_ids_file1"),
            "duplicate_ids_file2": comparison_result.get("duplicate_ids_file2"),
            "deterministic_violation_summary": DeterministicAuditService.summarise(evidence_packs),
        }

        # Format PAYE bands for the prompt (from config — not hardcoded)
        paye_bands_text = "\n".join(
            f"  {b['label']}" for b in PAYE_BANDS_MONTHLY if "label" in b
        )

        # Assemble prompt
        human_prompt = HUMAN_PROMPT_TEMPLATE.format(
            sample_note=sample_note,
            paye_bands=paye_bands_text,
            comparison_summary=json.dumps(comparison_summary, indent=2, default=str),
            evidence_packs=json.dumps(evidence_packs, indent=2, default=str),
            additional_payload=json.dumps(additional_payload, indent=2, default=str),
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
            return cls._fallback_report(f"Model returned unparseable output: {exc}")

        # Validate that the model actually filled the required fields.
        # Small/quantized models sometimes return a valid but near-empty JSON
        # object that doesn't satisfy the schema.
        _VALID_RISK_LEVELS = {"low", "medium", "high", "critical"}
        missing_summary = not parsed.get("executive_summary") or not str(parsed["executive_summary"]).strip()
        invalid_risk = str(parsed.get("risk_level", "")).lower() not in _VALID_RISK_LEVELS

        if missing_summary or invalid_risk:
            logger.warning(
                "Model '%s' returned an incomplete schema response. "
                "missing_summary=%s, invalid_risk=%s. Raw keys returned: %s",
                OLLAMA_MODEL,
                missing_summary,
                invalid_risk,
                list(parsed.keys()),
            )
            return cls._fallback_report(
                f"Model '{OLLAMA_MODEL}' returned an incomplete response — it did not "
                f"populate the required 'executive_summary' and/or 'risk_level' fields. "
                f"This usually means the model is too small to follow the required JSON "
                f"schema. Try a larger model (e.g. llama3, mistral, gemma3:4b)."
            )

        # Fill any missing optional top-level keys with safe defaults
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
            "executive_summary": parsed["executive_summary"],
            "risk_level": parsed["risk_level"],
            "key_findings": parsed["key_findings"],
            "statutory_compliance": parsed["statutory_compliance"],
            "recommended_actions": parsed["recommended_actions"],
            # Include raw evidence packs so the API consumer can use them without
            # re-parsing the AI narrative.
            "deterministic_violations": evidence_packs,
            "deterministic_summary": DeterministicAuditService.summarise(evidence_packs),
        }