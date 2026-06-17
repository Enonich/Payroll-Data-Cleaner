"""
Cleaning job lifecycle and persistence.
"""
from __future__ import annotations

import uuid
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

import pandas as pd

from app.config import EXPORT_DIR
from app.services.db_service import DBService
from app.services.file_service import FileService
from app.services.import_template_service import ImportTemplateService
from app.services.pipeline_service import PipelineService


VALID_STATUSES = {"pending", "processing", "needs_review", "completed", "failed"}


class JobService:
    """Service for creating, processing, fixing, and exporting template jobs."""

    @staticmethod
    def _now() -> str:
        return datetime.utcnow().isoformat()

    @staticmethod
    def _parse_job_row(row: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "id": row["id"],
            "template_id": row["template_id"],
            "source_file_id": row["source_file_id"],
            "source_filename": row["source_filename"],
            "status": row["status"],
            "output_format": row["output_format"],
            "working_path": row.get("working_path"),
            "output_path": row.get("output_path"),
            "issues": DBService.loads_json(row.get("issues_json", "[]"), []),
            "accepted_issue_ids": DBService.loads_json(
                row.get("accepted_issue_ids_json", "[]"), []
            ),
            "error_message": row.get("error_message"),
            "created_at": row["created_at"],
            "updated_at": row["updated_at"],
        }

    @classmethod
    def _save_job(cls, job: Dict[str, Any]) -> None:
        if job["status"] not in VALID_STATUSES:
            raise ValueError(f"Invalid job status '{job['status']}'")

        DBService.execute(
            """
            UPDATE jobs
            SET status = ?, output_format = ?, working_path = ?, output_path = ?,
                issues_json = ?, accepted_issue_ids_json = ?, error_message = ?, updated_at = ?
            WHERE id = ?
            """,
            (
                job["status"],
                job["output_format"],
                job.get("working_path"),
                job.get("output_path"),
                DBService.dumps_json(job.get("issues", [])),
                DBService.dumps_json(job.get("accepted_issue_ids", [])),
                job.get("error_message"),
                cls._now(),
                job["id"],
            ),
        )

    @classmethod
    def create_job(cls, source_file_id: str, template_id: str) -> Dict[str, Any]:
        source_info = FileService.get_file_info(source_file_id)
        if not source_info:
            raise ValueError("Source file not found")

        template = ImportTemplateService.get_template(template_id)
        if not template:
            raise ValueError("Template not found")

        job_id = str(uuid.uuid4())
        now = cls._now()
        output_format = template["definition"].get("output_format", "csv")

        DBService.execute(
            """
            INSERT INTO jobs (
                id, template_id, source_file_id, source_filename, status, output_format,
                working_path, output_path, issues_json, accepted_issue_ids_json,
                error_message, created_at, updated_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                job_id,
                template_id,
                source_file_id,
                source_info.get("filename", "uploaded_file"),
                "pending",
                output_format,
                None,
                None,
                "[]",
                "[]",
                None,
                now,
                now,
            ),
        )

        job = cls.get_job(job_id)
        if not job:
            raise ValueError("Failed to create job")
        return job

    @classmethod
    def list_jobs(cls) -> List[Dict[str, Any]]:
        rows = DBService.fetch_all(
            """
            SELECT * FROM jobs
            ORDER BY updated_at DESC
            """
        )
        return [cls._parse_job_row(row) for row in rows]

    @classmethod
    def get_job(cls, job_id: str) -> Optional[Dict[str, Any]]:
        row = DBService.fetch_one("SELECT * FROM jobs WHERE id = ?", (job_id,))
        return cls._parse_job_row(row) if row else None

    @classmethod
    def _write_outputs(cls, job_id: str, df: pd.DataFrame, output_format: str) -> Dict[str, str]:
        working_path = EXPORT_DIR / f"{job_id}_working.csv"
        df.to_csv(working_path, index=False)

        if output_format == "xlsx":
            output_path = EXPORT_DIR / f"{job_id}_cleaned.xlsx"
            df.to_excel(output_path, index=False, engine="openpyxl")
        else:
            output_path = EXPORT_DIR / f"{job_id}_cleaned.csv"
            df.to_csv(output_path, index=False)

        return {"working_path": str(working_path), "output_path": str(output_path)}

    @classmethod
    def process_job(cls, job_id: str) -> Dict[str, Any]:
        job = cls.get_job(job_id)
        if not job:
            raise ValueError("Job not found")

        template = ImportTemplateService.get_template(job["template_id"])
        if not template:
            raise ValueError("Template not found")

        source_df = FileService.get_dataframe(job["source_file_id"])
        if source_df is None:
            raise ValueError("Source dataframe not found")

        job["status"] = "processing"
        job["error_message"] = None
        cls._save_job(job)

        try:
            result = PipelineService.process(source_df, template["definition"])
            outputs = cls._write_outputs(job_id, result.dataframe, job["output_format"])

            job["working_path"] = outputs["working_path"]
            job["output_path"] = outputs["output_path"]
            job["issues"] = result.issues
            job["status"] = "needs_review" if result.issues else "completed"
            cls._save_job(job)
        except Exception as exc:
            job["status"] = "failed"
            job["error_message"] = str(exc)
            cls._save_job(job)

        updated = cls.get_job(job_id)
        if not updated:
            raise ValueError("Job disappeared during processing")
        return updated

    @classmethod
    def apply_fixes(
        cls,
        job_id: str,
        corrections: List[Dict[str, Any]],
        accepted_issue_ids: Optional[List[str]] = None,
    ) -> Dict[str, Any]:
        job = cls.get_job(job_id)
        if not job:
            raise ValueError("Job not found")
        if not job.get("working_path"):
            raise ValueError("Job has no working output to fix")

        template = ImportTemplateService.get_template(job["template_id"])
        if not template:
            raise ValueError("Template not found")

        working_path = Path(job["working_path"])
        if not working_path.exists():
            raise ValueError("Working output file no longer exists")

        df = pd.read_csv(working_path)

        for item in corrections:
            row_index = int(item["row_index"])
            field = item["field"]
            value = item.get("value")
            if field not in df.columns:
                raise ValueError(f"Field '{field}' not found in output")
            if row_index < 0 or row_index >= len(df.index):
                raise ValueError(f"row_index out of range: {row_index}")
            df.at[row_index, field] = value

        revalidated_issues = PipelineService.revalidate(df, template["definition"])

        accepted = set(job.get("accepted_issue_ids", []))
        if accepted_issue_ids:
            accepted.update(accepted_issue_ids)

        open_issues = []
        for issue in revalidated_issues:
            if issue["id"] in accepted:
                issue["status"] = "accepted"
            open_issues.append(issue)

        unresolved = [i for i in open_issues if i["status"] == "open"]
        outputs = cls._write_outputs(job_id, df, job["output_format"])

        job["working_path"] = outputs["working_path"]
        job["output_path"] = outputs["output_path"]
        job["issues"] = open_issues
        job["accepted_issue_ids"] = sorted(list(accepted))
        job["status"] = "needs_review" if unresolved else "completed"
        job["error_message"] = None
        cls._save_job(job)

        updated = cls.get_job(job_id)
        if not updated:
            raise ValueError("Job disappeared while applying fixes")
        return updated

    @classmethod
    def get_job_preview(cls, job_id: str, rows: int = 100, only_flagged: bool = False) -> Dict[str, Any]:
        job = cls.get_job(job_id)
        if not job:
            raise ValueError("Job not found")
        if not job.get("working_path"):
            raise ValueError("Job has no working output")

        path = Path(job["working_path"])
        if not path.exists():
            raise ValueError("Working output file does not exist")

        df = pd.read_csv(path)

        if only_flagged:
            flagged_rows = sorted(
                {
                    int(issue["row_index"])
                    for issue in job.get("issues", [])
                    if isinstance(issue.get("row_index"), int) and issue["row_index"] >= 0
                }
            )
            if flagged_rows:
                df = df.loc[flagged_rows]
            else:
                df = df.iloc[0:0]

        preview_df = df.head(rows)
        records = []
        for row_index, row in preview_df.iterrows():
            record = row.to_dict()
            record["__row_index"] = int(row_index)
            records.append(record)

        columns = [c for c in preview_df.columns.tolist()]
        return {
            "columns": columns,
            "data": records,
            "total_rows": len(df),
            "preview_rows": len(preview_df),
        }
