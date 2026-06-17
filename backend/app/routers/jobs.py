"""
Cleaning job lifecycle endpoints.
"""
from pathlib import Path
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel

from app.services.job_service import JobService

router = APIRouter()


class JobCreateRequest(BaseModel):
    source_file_id: str
    template_id: str


class JobFixRequest(BaseModel):
    corrections: List[Dict[str, Any]] = []
    accepted_issue_ids: Optional[List[str]] = None


@router.post("/")
async def create_job(request: JobCreateRequest):
    try:
        job = JobService.create_job(request.source_file_id, request.template_id)
        processed = JobService.process_job(job["id"])
        return {"message": "Job created", "job": processed}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/")
async def list_jobs():
    jobs = JobService.list_jobs()
    return {"jobs": jobs, "count": len(jobs)}


@router.get("/{job_id}")
async def get_job(job_id: str):
    job = JobService.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job


@router.get("/{job_id}/preview")
async def get_job_preview(job_id: str, rows: int = 100, only_flagged: bool = False):
    try:
        return JobService.get_job_preview(job_id, rows, only_flagged)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.post("/{job_id}/fix")
async def fix_job(job_id: str, request: JobFixRequest):
    try:
        job = JobService.apply_fixes(job_id, request.corrections, request.accepted_issue_ids)
        return {"message": "Fixes applied", "job": job}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/{job_id}/download")
async def download_job_output(job_id: str):
    job = JobService.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    if job["status"] != "completed":
        raise HTTPException(status_code=400, detail="Job must be completed before download")
    if not job.get("output_path"):
        raise HTTPException(status_code=404, detail="Output file not found")

    output_path = Path(job["output_path"])
    if not output_path.exists():
        raise HTTPException(status_code=404, detail="Output file does not exist on disk")

    media_type = "text/csv" if output_path.suffix.lower() == ".csv" else "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    return FileResponse(path=str(output_path), filename=output_path.name, media_type=media_type)
