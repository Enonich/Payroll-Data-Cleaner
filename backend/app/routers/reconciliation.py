"""
Reconciliation review endpoints.
"""
from typing import Optional, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.reconciliation_service import ReconciliationService
from app.services.ai_comparison_service import AIComparisonService

router = APIRouter()


class IssueActionRequest(BaseModel):
    action: str
    actor: str = "Payroll Officer"
    note: Optional[str] = None


class BulkIssueActionRequest(BaseModel):
    issue_ids: List[str]
    action: str
    actor: str = "Payroll Officer"
    note: Optional[str] = None


class InvestigatedDifferencesExportRequest(BaseModel):
    employee_ids: List[str]


@router.get("/")
async def list_reconciliation_runs():
    runs = ReconciliationService.list_runs()
    return {"runs": runs, "count": len(runs)}


@router.get("/dashboard/summary")
async def get_dashboard_summary():
    return ReconciliationService.get_dashboard_summary()


@router.get("/{run_id}")
async def get_reconciliation_run(run_id: str):
    try:
        return ReconciliationService.get_run(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{run_id}/issues/bulk/action")
async def apply_bulk_issue_action(run_id: str, request: BulkIssueActionRequest):
    try:
        return ReconciliationService.apply_bulk_issue_action(
            run_id,
            request.issue_ids,
            request.action,
            request.actor,
            request.note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/{run_id}/issues/{issue_id}/action")
async def apply_issue_action(run_id: str, issue_id: str, request: IssueActionRequest):
    try:
        return ReconciliationService.apply_issue_action(
            run_id,
            issue_id,
            request.action,
            request.actor,
            request.note,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/{run_id}/export-approved")
async def export_approved_updates(run_id: str):
    try:
        return ReconciliationService.export_approved_updates(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/{run_id}/export-role-differences")
async def export_role_differences(run_id: str):
    try:
        return ReconciliationService.export_role_differences(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/{run_id}/export-investigated-differences")
async def export_investigated_differences(run_id: str, request: InvestigatedDifferencesExportRequest):
    try:
        return ReconciliationService.export_investigated_differences(run_id, request.employee_ids)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{run_id}/report")
async def get_reconciliation_report(run_id: str):
    try:
        return ReconciliationService.generate_run_report(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.get("/{run_id}/employee/{employee_id}")
def get_employee_bundle(run_id: str, employee_id: str):
    """Pull an employee's full row(s) from both source files plus their flagged issues.

    A plain (non-async) def so FastAPI runs it in its threadpool -- keeps the event loop
    free while other employees' requests are in flight."""
    try:
        return ReconciliationService.get_employee_bundle(run_id, employee_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{run_id}/employee/{employee_id}/investigate")
def investigate_employee(run_id: str, employee_id: str):
    """Fetch the employee's full data and ask the AI to explain their flagged differences.

    A plain (non-async) def so this blocking LLM call runs in FastAPI's threadpool instead
    of the event loop -- otherwise a bulk investigation of several employees would run one
    at a time, appearing to only investigate whichever request happened to go first."""
    try:
        bundle = ReconciliationService.get_employee_bundle(run_id, employee_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))

    bundle["investigation"] = AIComparisonService.investigate_employee(bundle)
    return bundle


@router.post("/{run_id}/report/export")
async def export_reconciliation_report(run_id: str):
    try:
        return ReconciliationService.export_run_report(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
