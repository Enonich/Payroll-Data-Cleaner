"""
SQLite persistence for templates and cleaning jobs.
"""
import json
import sqlite3
from pathlib import Path
from threading import Lock
from typing import Any, Dict, List, Optional

from app.config import BASE_DIR


class DBService:
    """Simple SQLite wrapper for template and job persistence."""

    _db_path = BASE_DIR / "app_data.db"
    _init_lock = Lock()
    _initialized = False

    @classmethod
    def _connect(cls) -> sqlite3.Connection:
        conn = sqlite3.connect(str(cls._db_path))
        conn.row_factory = sqlite3.Row
        return conn

    @classmethod
    def initialize(cls) -> None:
        with cls._init_lock:
            if cls._initialized:
                return
            conn = cls._connect()
            try:
                cur = conn.cursor()
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS templates (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        target_system TEXT NOT NULL,
                        import_type TEXT NOT NULL,
                        definition_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS jobs (
                        id TEXT PRIMARY KEY,
                        template_id TEXT NOT NULL,
                        source_file_id TEXT NOT NULL,
                        source_filename TEXT NOT NULL,
                        status TEXT NOT NULL,
                        output_format TEXT NOT NULL,
                        working_path TEXT,
                        output_path TEXT,
                        issues_json TEXT NOT NULL,
                        accepted_issue_ids_json TEXT NOT NULL,
                        error_message TEXT,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        FOREIGN KEY(template_id) REFERENCES templates(id)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS reconciliation_runs (
                        id TEXT PRIMARY KEY,
                        source_file1_id TEXT NOT NULL,
                        source_file2_id TEXT NOT NULL,
                        file1_label TEXT NOT NULL,
                        file2_label TEXT NOT NULL,
                        summary_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS reconciliation_issues (
                        id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL,
                        issue_type TEXT NOT NULL,
                        status TEXT NOT NULL,
                        employee_id TEXT,
                        employee_name TEXT,
                        field TEXT,
                        old_value TEXT,
                        new_value TEXT,
                        difference REAL,
                        confidence REAL NOT NULL,
                        suggested_action TEXT NOT NULL,
                        explanation TEXT NOT NULL,
                        source_json TEXT NOT NULL,
                        created_at TEXT NOT NULL,
                        updated_at TEXT NOT NULL,
                        FOREIGN KEY(run_id) REFERENCES reconciliation_runs(id)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS reconciliation_audit (
                        id TEXT PRIMARY KEY,
                        run_id TEXT NOT NULL,
                        issue_id TEXT,
                        action TEXT NOT NULL,
                        actor TEXT NOT NULL,
                        note TEXT,
                        before_status TEXT,
                        after_status TEXT,
                        created_at TEXT NOT NULL,
                        FOREIGN KEY(run_id) REFERENCES reconciliation_runs(id),
                        FOREIGN KEY(issue_id) REFERENCES reconciliation_issues(id)
                    )
                    """
                )
                conn.commit()
                cls._initialized = True
            finally:
                conn.close()

    @classmethod
    def fetch_all(cls, query: str, params: tuple = ()) -> List[Dict[str, Any]]:
        cls.initialize()
        conn = cls._connect()
        try:
            cur = conn.cursor()
            cur.execute(query, params)
            return [dict(row) for row in cur.fetchall()]
        finally:
            conn.close()

    @classmethod
    def fetch_one(cls, query: str, params: tuple = ()) -> Optional[Dict[str, Any]]:
        cls.initialize()
        conn = cls._connect()
        try:
            cur = conn.cursor()
            cur.execute(query, params)
            row = cur.fetchone()
            return dict(row) if row else None
        finally:
            conn.close()

    @classmethod
    def execute(cls, query: str, params: tuple = ()) -> None:
        cls.initialize()
        conn = cls._connect()
        try:
            cur = conn.cursor()
            cur.execute(query, params)
            conn.commit()
        finally:
            conn.close()

    @staticmethod
    def dumps_json(value: Any) -> str:
        return json.dumps(value, ensure_ascii=True)

    @staticmethod
    def loads_json(value: str, fallback: Any) -> Any:
        if not value:
            return fallback
        try:
            return json.loads(value)
        except json.JSONDecodeError:
            return fallback
