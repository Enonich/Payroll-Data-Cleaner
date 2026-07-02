"""
Export router - handles file export and download endpoints
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from typing import Optional, List
from pydantic import BaseModel
import io
from app.services.file_service import FileService

router = APIRouter()


class ExportRequest(BaseModel):
    file_id: str
    format: str = "csv"  # "csv" or "xlsx"
    filename: Optional[str] = None


class BulkExportRequest(BaseModel):
    file_ids: List[str]
    format: str = "csv"


@router.post("/download")
async def export_file(request: ExportRequest):
    """
    Export a file to CSV or Excel format
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    file_info = FileService.get_file_info(request.file_id)
    
    try:
        export_path = FileService.export_dataframe(
            request.file_id,
            request.format,
            request.filename
        )
        
        if export_path is None:
            raise HTTPException(status_code=500, detail="Export failed")
        
        media_type = "text/csv" if request.format == "csv" else \
                     "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        
        return FileResponse(
            path=str(export_path),
            filename=export_path.name,
            media_type=media_type
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{file_id}/csv")
async def download_as_csv(file_id: str):
    """
    Download a file as CSV
    """
    df = FileService.get_dataframe(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    file_info = FileService.get_file_info(file_id)

    # Generate CSV in memory
    buffer = io.StringIO()
    df.to_csv(buffer, index=False)
    buffer.seek(0)

    original_name = (file_info or {}).get('filename', 'export')
    base = original_name.rsplit('.', 1)[0] if '.' in original_name else original_name
    filename = f"{base}.csv"

    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{file_id}/excel")
async def download_as_excel(file_id: str):
    """
    Download a file as Excel
    """
    df = FileService.get_dataframe(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    file_info = FileService.get_file_info(file_id)

    # Generate Excel in memory
    buffer = io.BytesIO()
    df.to_excel(buffer, index=False, engine='openpyxl')
    buffer.seek(0)

    original_name = (file_info or {}).get('filename', 'export')
    base = original_name.rsplit('.', 1)[0] if '.' in original_name else original_name
    filename = f"{base}.xlsx"

    return StreamingResponse(
        iter([buffer.getvalue()]),
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/{file_id}/json")
async def get_as_json(file_id: str, orient: str = "records"):
    """
    Get file data as JSON
    
    orient options: records, columns, index, split, table
    """
    df = FileService.get_dataframe(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    try:
        if orient == "records":
            return df.to_dict(orient='records')
        elif orient == "columns":
            return df.to_dict(orient='dict')
        elif orient == "split":
            return df.to_dict(orient='split')
        else:
            return df.to_dict(orient='records')
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/bulk-csv")
async def bulk_export_csv(request: BulkExportRequest):
    """
    Export multiple files and return download links
    """
    results = []
    errors = []
    
    for file_id in request.file_ids:
        df = FileService.get_dataframe(file_id)
        if df is None:
            errors.append({"file_id": file_id, "error": "File not found"})
            continue
        
        try:
            file_info = FileService.get_file_info(file_id)
            export_path = FileService.export_dataframe(file_id, request.format)
            
            if export_path:
                results.append({
                    "file_id": file_id,
                    "original_name": file_info.get('filename'),
                    "export_path": str(export_path),
                    "export_name": export_path.name
                })
        except Exception as e:
            errors.append({"file_id": file_id, "error": str(e)})
    
    return {
        "exported": results,
        "errors": errors,
        "total_exported": len(results),
        "total_errors": len(errors)
    }


@router.get("/{file_id}/stats")
async def get_file_statistics(file_id: str):
    """
    Get statistical summary of numeric columns in a file
    """
    df = FileService.get_dataframe(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    # Get numeric columns
    numeric_cols = df.select_dtypes(include=['int64', 'float64']).columns.tolist()
    
    stats = {}
    for col in numeric_cols:
        stats[col] = {
            "count": int(df[col].count()),
            "mean": float(df[col].mean()) if df[col].count() > 0 else None,
            "std": float(df[col].std()) if df[col].count() > 0 else None,
            "min": float(df[col].min()) if df[col].count() > 0 else None,
            "max": float(df[col].max()) if df[col].count() > 0 else None,
            "sum": float(df[col].sum()) if df[col].count() > 0 else None,
            "null_count": int(df[col].isna().sum())
        }
    
    return {
        "file_id": file_id,
        "total_rows": len(df),
        "total_columns": len(df.columns),
        "numeric_columns": len(numeric_cols),
        "statistics": stats
    }
