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

OLLAMA_TIMEOUT    = 180   # seconds per model call
CHUNK_SIZE        = 25    # max evidence packs per AI call
TOKEN_LIMIT_CHUNK = 4_000 # rough token ceiling per chunk (~4 chars/token)
MAX_MISMATCH_ROWS = 60    # rows kept in additional payload

# ---------------------------------------------------------------------------
# CHUNKED DESIGN
# The AI is asked ONLY for key_findings (one chunk of <=CHUNK_SIZE packs).
# executive_summary and risk_level are built DETERMINISTICALLY in Python so
# they are always populated regardless of model quality or size.
# ---------------------------------------------------------------------------
SYSTEM_PROMPT = """
You are a senior payroll auditor specialising in Ghanaian public and private sector
payroll. Your role is that of an EXPLANATION ENGINE -- not a detector.

Our audit engine has already run all deterministic checks and produced structured
evidence packs for every violation found.

Your task for each batch:
1. Transform each evidence pack into a clear, plain-language finding for the
   payroll officer reviewing the data.
2. Confirm the severity and provide a specific, actionable recommended_action.
3. Quote actual values, employee IDs, and field names from the evidence.
4. Do NOT invent issues beyond what the evidence packs show.
"""

CHUNK_HUMAN_PROMPT = """
Below are {n} pre-computed payroll violation(s) found by our deterministic audit engine.
For each violation provide one entry in key_findings.

Return ONLY valid JSON with this exact shape -- no preamble, no markdown fences:
{{
  "key_findings": [
    {{
      "category": "net_pay | paye | ssnit | provident_fund | allowances | presence | duplicates | names | account_numbers | salary | cross_field | data_quality",
      "severity": "low | medium | high | critical",
      "confidence": 100,
      "finding": "Plain-language explanation for the payroll officer. Name specific employees or IDs. Quote before/after amounts.",
      "evidence": "Exact values, field names, and amounts from the evidence pack. Use GHS currency.",
      "affected_count": 1,
      "recommended_action": "One specific, actionable next step referencing the evidence."
    }}
  ]
}}

Current PAYE bands (for context):
{paye_bands}

Evidence packs for this batch:
{evidence_packs}
"""

# Kept for backward-compat imports only
HUMAN_PROMPT_TEMPLATE = ""


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
        return 0 if df is None else len(df)

    @staticmethod
    def _extract_json(text: str) -> Dict[str, Any]:
        """Extract a JSON object from model output, stripping any markdown fences."""
        if not text or not text.strip():
            raise ValueError("AI model returned an empty response.")

        fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.DOTALL)
        candidate = fenced.group(1) if fenced else text.strip()

        if not candidate.startswith("{"):
            start = candidate.find("{")
            end   = candidate.rfind("}")
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
        return len(text) // 4

    # ── fallback / error reports ──────────────────────────────────────────────

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
                "notes": "AI layer unavailable -- statutory checks not performed.",
            },
            "key_findings": [],
            "recommended_actions": [
                "Ensure Ollama is running: `ollama serve`",
                f"Ensure the model is available: `ollama pull {OLLAMA_MODEL}`",
                "Retry the AI audit once Ollama is confirmed running.",
            ],
            "chunks_processed": 0,
            "chunks_total": 0,
        }

    @staticmethod
    def _no_match_report(comparison_result: Dict[str, Any]) -> Dict[str, Any]:
        total_f1 = comparison_result.get("total_file1", 0) or 0
        total_f2 = comparison_result.get("total_file2", 0) or 0
        logger.warning("No employee records matched. file1=%d, file2=%d", total_f1, total_f2)
        return {
            "enabled": True,
            "available": True,
            "model": OLLAMA_MODEL,
            "executive_summary": (
                f"No employees could be matched between the two files "
                f"(File 1: {total_f1} records, File 2: {total_f2} records). "
                "This is a matching-key configuration problem. All findings below are "
                "blocked until matching is resolved."
            ),
            "risk_level": "critical",
            "statutory_compliance": {
                "ssnit_ok": None, "paye_ok": None,
                "net_pay_ok": None, "ssf_ok": None,
                "notes": "Cannot perform statutory checks -- no records matched.",
            },
            "key_findings": [{
                "category": "presence",
                "severity": "critical",
                "confidence": 100,
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
                    "try Account Number or SSNIT number."
                ),
            }],
            "recommended_actions": [
                "Select an identifier column that contains real values in both files.",
                "If Staff ID is unreliable, use Account Number or SSNIT Number.",
                "Check that both files cover the same pay period and staff population.",
            ],
            "chunks_processed": 0,
            "chunks_total": 0,
        }

    # ── payload builder ───────────────────────────────────────────────────────

    @classmethod
    def build_payload(
        cls, comparison_result: Dict[str, Any]
    ) -> tuple[Dict[str, Any], str, List[Dict[str, Any]]]:
        """Run deterministic checks and return (additional_payload, sample_note, evidence_packs)."""
        evidence_packs   = DeterministicAuditService.build_evidence_packs(comparison_result)
        total_mismatches = cls._total_rows(comparison_result.get("mismatches_df"))
        mismatch_sample  = cls._records(comparison_result.get("mismatches_df"), MAX_MISMATCH_ROWS)

        sample_note = (
            f"NOTE: Showing {len(mismatch_sample)} of {total_mismatches} mismatched rows."
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

        payload_str = json.dumps(additional_payload, default=str)
        if cls._estimate_tokens(payload_str) > TOKEN_LIMIT_CHUNK * 2:
            additional_payload["top_mismatches"] = mismatch_sample[:30]
            sample_note = f"NOTE: Payload trimmed. Showing 30 of {total_mismatches} rows."

        return additional_payload, sample_note, evidence_packs

    # ── chunk processing ──────────────────────────────────────────────────────

    @classmethod
    def _process_chunk(
        cls,
        llm: "ChatOllama",
        chunk: List[Dict[str, Any]],
        paye_bands_text: str,
    ) -> List[Dict[str, Any]]:
        """Call the model for one chunk; returns key_findings list (may be empty on failure)."""
        if not chunk:
            return []

        prompt = CHUNK_HUMAN_PROMPT.format(
            n=len(chunk),
            paye_bands=paye_bands_text,
            evidence_packs=json.dumps(chunk, indent=2, default=str),
        )

        try:
            response = llm.invoke([SystemMessage(content=SYSTEM_PROMPT), HumanMessage(content=prompt)])
            raw      = getattr(response, "content", None) or str(response)
            parsed   = cls._extract_json(raw)
            findings = parsed.get("key_findings")
            if isinstance(findings, list):
                return findings
            logger.warning("Chunk model returned unexpected key_findings type: %s", type(findings))
        except Exception as exc:
            logger.warning("Chunk model call failed (%s): %s", type(exc).__name__, exc)

        return []

    # ── deterministic synthesis ───────────────────────────────────────────────

    @staticmethod
    def _derive_statutory_compliance(evidence_packs: List[Dict[str, Any]]) -> Dict[str, Any]:
        packed = str(evidence_packs).lower()
        has_ssf  = "ssf" in packed or "ssnit" in packed
        has_paye = "paye" in packed or "income tax" in packed
        has_net  = "net" in packed or "take home" in packed
        return {
            "ssnit_ok":   False if has_ssf  else None,
            "paye_ok":    False if has_paye else None,
            "net_pay_ok": False if has_net  else None,
            "ssf_ok":     False if has_ssf  else None,
            "notes": (
                "Statutory compliance flags derived from deterministic audit results."
                if (has_ssf or has_paye or has_net)
                else "No SSF/PAYE/net-pay issues detected."
            ),
        }

    @classmethod
    def _build_synthesis(
        cls,
        findings: List[Dict[str, Any]],
        comparison_summary: Dict[str, Any],
        evidence_packs: List[Dict[str, Any]],
        column_roles: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Deterministically build executive_summary, risk_level, statutory_compliance,
        and recommended_actions.  Always succeeds regardless of model quality.
        """
        _SEV = {"critical": 4, "blocking": 4, "high": 3, "medium": 2, "low": 1}

        all_items = findings if findings else evidence_packs
        max_sev   = max((_SEV.get(str(x.get("severity", "low")).lower(), 1) for x in all_items), default=1)
        risk      = {4: "critical", 3: "high", 2: "medium", 1: "low"}[max_sev]

        matched   = int(comparison_summary.get("matched", 0) or 0)
        with_diff = int(comparison_summary.get("employees_with_differences", 0) or 0)
        only_f1   = int(comparison_summary.get("only_in_file1", 0) or 0)
        only_f2   = int(comparison_summary.get("only_in_file2", 0) or 0)

        sev_counts: Dict[str, int] = {}
        for x in all_items:
            s = str(x.get("severity", "low")).lower()
            sev_counts[s] = sev_counts.get(s, 0) + 1

        sev_parts = [
            f"{sev_counts[lbl]} {lbl}"
            for lbl in ("critical", "high", "medium", "low")
            if sev_counts.get(lbl, 0)
        ]

        presence_note = ""
        if only_f1 or only_f2:
            presence_note = f" {only_f1} employee(s) only in File 1 and {only_f2} only in File 2."

        summary = (
            f"Audit completed across {matched} matched employees; "
            f"{with_diff} had payroll differences.{presence_note} "
            f"{len(all_items)} finding(s) identified"
            + (f" ({', '.join(sev_parts)})" if sev_parts else "")
            + f". Overall risk: {risk.upper()}."
        )

        top_actions = [
            x.get("recommended_action")
            for x in all_items
            if str(x.get("severity", "")).lower() in {"critical", "high", "blocking"}
            and x.get("recommended_action")
        ][:3]

        if not top_actions:
            top_actions = [
                "Review all flagged findings with the payroll team before approving.",
                "Verify employee presence discrepancies against HR records.",
                "Ensure written authorisations exist for any salary or allowance changes.",
            ]

        statutory = cls._derive_statutory_compliance(evidence_packs)

        if column_roles:
            allowances = [k for k, v in column_roles.items() if v == "allowance"]
            deductions = [k for k, v in column_roles.items() if v == "deduction"]
            if allowances:
                statutory["notes"] += f" User-classified allowances: {', '.join(allowances)}."
            if deductions:
                statutory["notes"] += f" User-classified deductions: {', '.join(deductions)}."

        return {
            "executive_summary": summary,
            "risk_level":        risk,
            "statutory_compliance": statutory,
            "recommended_actions":  top_actions,
        }

    @staticmethod
    def _findings_from_evidence(evidence_packs: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """Convert raw evidence packs to key_findings shape without AI (used as fallback)."""
        _CAT = {
            "DUPLICATE_ID":                "duplicates",
            "MISSING_FROM_FILE1":          "presence",
            "MISSING_FROM_FILE2":          "presence",
            "MISSING_STAFF_ID":            "data_quality",
            "ID_NAME_MISMATCH":            "names",
            "LARGE_SALARY_CHANGE":         "salary",
            "ALLOWANCE_WITHOUT_SALARY":    "allowances",
            "ZERO_OR_BLANK":               "data_quality",
            "NEGATIVE_VALUE":              "data_quality",
            "EMPLOYER_DEDUCTION_DETECTED": "cross_field",
        }
        results = []
        for pack in evidence_packs:
            issue_type = pack.get("issue_type", "UNKNOWN")
            results.append({
                "category":           _CAT.get(issue_type, "data_quality"),
                "severity":           pack.get("severity", "medium"),
                "confidence":         pack.get("confidence", 100),
                "finding":            pack.get("rule_triggered", "See evidence for details."),
                "evidence":           json.dumps(pack.get("evidence", {}), default=str)[:300],
                "affected_count":     1,
                "recommended_action": pack.get("recommended_action", "Review with the payroll team."),
            })
        return results

    # ── main entry point ──────────────────────────────────────────────────────

    @classmethod
    def generate_audit(
        cls,
        comparison_result: Dict[str, Any],
        column_roles: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """
        Run the AI audit with chunked evidence-pack processing.

        1. DeterministicAuditService pre-computes all violations (Python, 100% reliable).
        2. Evidence packs are split into chunks of CHUNK_SIZE.
        3. The model is asked ONLY for key_findings per chunk.
        4. executive_summary and risk_level are built DETERMINISTICALLY -- always present.
        5. column_roles: optional dict {label -> 'allowance'|'deduction'|'earning'} from user.
        """
        matched  = int(comparison_result.get("matched", 0)     or 0)
        total_f1 = int(comparison_result.get("total_file1", 0) or 0)
        total_f2 = int(comparison_result.get("total_file2", 0) or 0)

        if matched == 0 and (total_f1 > 0 or total_f2 > 0):
            return cls._no_match_report(comparison_result)

        # ── deterministic checks ──────────────────────────────────────────────
        try:
            _additional_payload, _sample_note, evidence_packs = cls.build_payload(comparison_result)
        except Exception as exc:
            logger.error("Failed to build AI audit payload: %s", exc, exc_info=True)
            return cls._fallback_report(f"Payload build error: {exc}")

        comparison_summary = {
            "total_file1":                   total_f1,
            "total_file2":                   total_f2,
            "matched":                       matched,
            "only_in_file1":                 comparison_result.get("only_in_file1"),
            "only_in_file2":                 comparison_result.get("only_in_file2"),
            "employees_with_differences":    comparison_result.get("employees_with_differences"),
            "employees_without_differences": comparison_result.get("employees_without_differences"),
            "field_differences":             comparison_result.get("field_differences"),
            "duplicate_ids_file1":           comparison_result.get("duplicate_ids_file1"),
            "duplicate_ids_file2":           comparison_result.get("duplicate_ids_file2"),
            "deterministic_violation_summary": DeterministicAuditService.summarise(evidence_packs),
            "column_roles":                  column_roles or {},
        }

        paye_bands_text = "\n".join(
            f"  {b['label']}" for b in PAYE_BANDS_MONTHLY if "label" in b
        )

        # ── split into chunks ─────────────────────────────────────────────────
        if evidence_packs:
            chunks: List[List[Dict[str, Any]]] = [
                evidence_packs[i : i + CHUNK_SIZE]
                for i in range(0, len(evidence_packs), CHUNK_SIZE)
            ]
        else:
            chunks = []  # nothing to explain; synthesis still runs

        # ── instantiate model ─────────────────────────────────────────────────
        try:
            llm = ChatOllama(
                model=OLLAMA_MODEL,
                base_url=OLLAMA_BASE_URL,
                temperature=0,
                format="json",
                num_ctx=8192,
                timeout=OLLAMA_TIMEOUT,
            )
        except Exception as exc:
            logger.error("Failed to instantiate Ollama model: %s", exc, exc_info=True)
            return cls._fallback_report(f"{type(exc).__name__}: {exc}")

        # ── process chunks ────────────────────────────────────────────────────
        all_findings: List[Dict[str, Any]] = []
        chunks_ok      = 0
        chunks_fail    = 0

        for i, chunk in enumerate(chunks):
            logger.info("Processing AI chunk %d/%d (%d packs)", i + 1, len(chunks), len(chunk))
            try:
                findings = cls._process_chunk(llm, chunk, paye_bands_text)
            except TimeoutError:
                logger.warning("Chunk %d timed out after %ds.", i + 1, OLLAMA_TIMEOUT)
                findings = []
            except Exception as exc:
                logger.warning("Chunk %d raised %s: %s", i + 1, type(exc).__name__, exc)
                findings = []

            if findings:
                all_findings.extend(findings)
                chunks_ok += 1
            else:
                all_findings.extend(cls._findings_from_evidence(chunk))
                chunks_fail += 1

        # ── deterministic synthesis (always succeeds) ────────────────────────
        synthesis = cls._build_synthesis(all_findings, comparison_summary, evidence_packs, column_roles)

        logger.info(
            "AI audit complete. chunks=%d ok=%d fallback=%d findings=%d risk=%s",
            len(chunks), chunks_ok, chunks_fail, len(all_findings), synthesis["risk_level"],
        )

        return {
            "enabled":                  True,
            "available":                True,
            "model":                    OLLAMA_MODEL,
            "executive_summary":        synthesis["executive_summary"],
            "risk_level":               synthesis["risk_level"],
            "key_findings":             all_findings,
            "statutory_compliance":     synthesis["statutory_compliance"],
            "recommended_actions":      synthesis["recommended_actions"],
            "deterministic_violations": evidence_packs,
            "deterministic_summary":    DeterministicAuditService.summarise(evidence_packs),
            "chunks_processed":         chunks_ok,
            "chunks_total":             len(chunks),
            "chunks_with_fallback":     chunks_fail,
            "column_roles":             column_roles or {},
        }
