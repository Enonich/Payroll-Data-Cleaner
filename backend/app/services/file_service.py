"""
File handling service - manages file uploads, storage, and retrieval
"""
import os
import uuid
import json
from pathlib import Path
from datetime import datetime
from typing import Dict, List, Optional, Tuple
import pandas as pd
import numpy as np
from app.config import UPLOAD_DIR, EXPORT_DIR, ALLOWED_EXTENSIONS, CSV_ENCODINGS


class FileService:
    """Service for handling file operations"""
    
    # In-memory store for file metadata and dataframes
    _files: Dict[str, Dict] = {}
    _dataframes: Dict[str, pd.DataFrame] = {}

    @staticmethod
    def _json_safe_scalar(value):
        if value is None:
            return None
        try:
            if pd.isna(value):
                return None
        except (TypeError, ValueError):
            pass
        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, pd.Timestamp):
            return value.isoformat()
        if hasattr(value, 'isoformat'):
            try:
                return value.isoformat()
            except (TypeError, ValueError):
                pass
        return value

    @classmethod
    def _json_safe_dataframe(cls, df: pd.DataFrame) -> pd.DataFrame:
        if df is None or len(df) == 0:
            return df
        if hasattr(df, 'map'):
            safe_df = df.map(cls._json_safe_scalar)
        else:
            safe_df = df.applymap(cls._json_safe_scalar)
        return safe_df.astype(object).where(pd.notna(safe_df), None)
    
    @classmethod
    def read_file(cls, filepath: Path, filename: str) -> Tuple[pd.DataFrame, str]:
        """
        Read a file (CSV or Excel) and return a DataFrame
        Tries multiple encodings for CSV files
        """
        ext = Path(filename).suffix.lower()
        
        if ext == '.csv':
            # Try multiple encodings
            for encoding in CSV_ENCODINGS:
                try:
                    df = pd.read_csv(filepath, encoding=encoding)
                    return df, encoding
                except (UnicodeDecodeError, pd.errors.ParserError):
                    continue
            raise ValueError(f"Could not read CSV file with any of the supported encodings")
        
        elif ext == '.xlsx':
            df = pd.read_excel(filepath, engine='openpyxl')
            return df, 'xlsx'
        
        elif ext == '.xls':
            # Some .xls files are actually HTML exports (e.g. from web apps).
            # Try HTML parsing first, then fall back to genuine xlrd binary.
            try:
                dfs = pd.read_html(str(filepath))
                if dfs:
                    return dfs[0], 'html'
            except Exception:
                pass
            # Genuine Excel 97-2003 binary format – requires xlrd 2.x
            df = pd.read_excel(filepath, engine='xlrd')
            return df, 'xls'
        
        else:
            raise ValueError(f"Unsupported file extension: {ext}")
    
    @classmethod
    def save_uploaded_file(cls, file_content: bytes, filename: str) -> str:
        """
        Save an uploaded file and return its ID
        """
        ext = Path(filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            raise ValueError(f"File type {ext} not allowed. Allowed: {ALLOWED_EXTENSIONS}")
        
        # Generate unique ID
        file_id = str(uuid.uuid4())
        
        # Save file to disk
        filepath = UPLOAD_DIR / f"{file_id}{ext}"
        with open(filepath, 'wb') as f:
            f.write(file_content)
        
        # Read the file into a DataFrame
        df, encoding = cls.read_file(filepath, filename)
        
        # Store metadata
        cls._files[file_id] = {
            'id': file_id,
            'filename': filename,
            'filepath': str(filepath),
            'file_type': ext,
            'encoding': encoding,
            'size': len(file_content),
            'columns': df.columns.tolist(),
            'row_count': len(df),
            'uploaded_at': datetime.now().isoformat()
        }
        
        # Store DataFrame
        cls._dataframes[file_id] = df
        
        return file_id
    
    @classmethod
    def get_file_info(cls, file_id: str) -> Optional[Dict]:
        """Get file metadata by ID"""
        return cls._files.get(file_id)
    
    @classmethod
    def get_dataframe(cls, file_id: str) -> Optional[pd.DataFrame]:
        """Get DataFrame by file ID, falling back to disk if not in memory."""
        df = cls._dataframes.get(file_id)
        if df is not None:
            return df
        return cls._try_load_from_disk(file_id)

    @classmethod
    def _try_load_from_disk(cls, file_id: str) -> Optional[pd.DataFrame]:
        """Reload a file from the uploads directory by file_id.
        Called automatically when a file is not found in memory
        (e.g. after a server restart with --reload).
        Returns the original unprocessed DataFrame or None.
        """
        for ext in ('.csv', '.xlsx', '.xls'):
            filepath = UPLOAD_DIR / f"{file_id}{ext}"
            if not filepath.exists():
                continue
            try:
                df, encoding = cls.read_file(filepath, filepath.name)
                cls._files[file_id] = {
                    'id': file_id,
                    'filename': filepath.name,
                    'filepath': str(filepath),
                    'file_type': ext,
                    'encoding': encoding,
                    'size': filepath.stat().st_size,
                    'columns': df.columns.tolist(),
                    'row_count': len(df),
                    'uploaded_at': datetime.now().isoformat(),
                }
                cls._dataframes[file_id] = df
                return df
            except Exception:
                pass
        return None
    
    @classmethod
    def update_dataframe(cls, file_id: str, df: pd.DataFrame) -> bool:
        """Update a stored DataFrame"""
        if file_id not in cls._files:
            return False
        cls._dataframes[file_id] = df
        cls._files[file_id]['columns'] = df.columns.tolist()
        cls._files[file_id]['row_count'] = len(df)
        return True
    
    @classmethod
    def get_preview(cls, file_id: str, rows: int = 100) -> Optional[Dict]:
        """Get a preview of the file data"""
        df = cls.get_dataframe(file_id)
        if df is None:
            return None
        
        preview_df = cls._json_safe_dataframe(df.head(rows))
        return {
            'columns': df.columns.tolist(),
            'data': preview_df.to_dict(orient='records'),
            'total_rows': len(df),
            'preview_rows': len(preview_df)
        }

    @classmethod
    def get_data(cls, file_id: str, offset: int = 0, limit: Optional[int] = None) -> Optional[Dict]:
        """Get file data with optional slicing. If limit is None, returns all rows from offset."""
        df = cls.get_dataframe(file_id)
        if df is None:
            return None

        safe_offset = max(0, int(offset or 0))
        if limit is None:
            data_df = df.iloc[safe_offset:]
        else:
            safe_limit = max(0, int(limit))
            data_df = df.iloc[safe_offset:safe_offset + safe_limit]

        data_df = cls._json_safe_dataframe(data_df)

        return {
            'columns': df.columns.tolist(),
            'data': data_df.to_dict(orient='records'),
            'total_rows': len(df),
            'returned_rows': len(data_df),
            'offset': safe_offset,
            'limit': limit,
        }
    
    @classmethod
    def list_files(cls) -> List[Dict]:
        """List all uploaded files"""
        return list(cls._files.values())
    
    @classmethod
    def delete_file(cls, file_id: str) -> bool:
        """Delete a file by ID"""
        if file_id not in cls._files:
            return False
        
        # Delete from disk
        filepath = Path(cls._files[file_id]['filepath'])
        if filepath.exists():
            filepath.unlink()
        
        # Remove from memory
        del cls._files[file_id]
        if file_id in cls._dataframes:
            del cls._dataframes[file_id]
        
        return True
    
    @classmethod
    def export_dataframe(cls, file_id: str, format: str = 'csv', 
                         filename: Optional[str] = None) -> Optional[Path]:
        """Export a DataFrame to a file"""
        df = cls.get_dataframe(file_id)
        if df is None:
            return None
        
        info = cls.get_file_info(file_id)
        if filename is None:
            base_name = Path(info['filename']).stem
            filename = f"{base_name}_processed"
        
        if format == 'csv':
            export_path = EXPORT_DIR / f"{filename}.csv"
            df.to_csv(export_path, index=False)
        elif format == 'xlsx':
            export_path = EXPORT_DIR / f"{filename}.xlsx"
            df.to_excel(export_path, index=False, engine='openpyxl')
        else:
            raise ValueError(f"Unsupported export format: {format}")
        
        return export_path
    
    @classmethod
    def create_new_file(cls, df: pd.DataFrame, filename: str) -> str:
        """Create a new file entry from a DataFrame"""
        file_id = str(uuid.uuid4())
        
        cls._files[file_id] = {
            'id': file_id,
            'filename': filename,
            'filepath': None,
            'file_type': 'generated',
            'is_generated': True,
            'encoding': 'utf-8',
            'size': 0,
            'columns': df.columns.tolist(),
            'row_count': len(df),
            'uploaded_at': datetime.now().isoformat()
        }
        
        cls._dataframes[file_id] = df
        return file_id
