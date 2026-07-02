"""
Reconciliation review endpoints.
"""
from typing import Optional, List

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.reconciliation_service import ReconciliationService

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


@router.post("/{run_id}/export-approved")
async def export_approved_updates(run_id: str):
    try:
        return ReconciliationService.export_approved_updates(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{run_id}/report")
async def get_reconciliation_report(run_id: str):
    try:
        return ReconciliationService.generate_run_report(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))


@router.post("/{run_id}/report/export")
async def export_reconciliation_report(run_id: str):
    try:
        return ReconciliationService.export_run_report(run_id)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc))
