"""
Upload router - handles file upload endpoints
"""
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi.responses import JSONResponse
from typing import List
from app.services.file_service import FileService
from app.config import MAX_FILE_SIZE, ALLOWED_EXTENSIONS

router = APIRouter()


@router.post("/")
async def upload_file(file: UploadFile = File(...)):
    """
    Upload a single file (CSV or Excel)
    """
    # Validate file extension
    filename = file.filename or "unknown"
    ext = filename.split('.')[-1].lower() if '.' in filename else ''
    if f'.{ext}' not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"File type .{ext} not allowed. Allowed types: {', '.join(ALLOWED_EXTENSIONS)}"
        )
    
    # Read file content
    content = await file.read()
    
    # Validate file size
    if len(content) > MAX_FILE_SIZE:
        raise HTTPException(
            status_code=400,
            detail=f"File too large. Maximum size is {MAX_FILE_SIZE / (1024*1024):.0f}MB"
        )
    
    try:
        file_id = FileService.save_uploaded_file(content, filename)
        file_info = FileService.get_file_info(file_id)
        return JSONResponse(content={
            "message": "File uploaded successfully",
            "file": file_info
        })
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error processing file: {str(e)}")


@router.post("/multiple")
async def upload_multiple_files(files: List[UploadFile] = File(...)):
    """
    Upload multiple files
    """
    results = []
    errors = []
    
    for file in files:
        filename = file.filename or "unknown"
        ext = filename.split('.')[-1].lower() if '.' in filename else ''
        
        if f'.{ext}' not in ALLOWED_EXTENSIONS:
            errors.append({"filename": filename, "error": f"File type .{ext} not allowed"})
            continue
        
        try:
            content = await file.read()
            
            if len(content) > MAX_FILE_SIZE:
                errors.append({"filename": filename, "error": "File too large"})
                continue
            
            file_id = FileService.save_uploaded_file(content, filename)
            file_info = FileService.get_file_info(file_id)
            results.append(file_info)
        except Exception as e:
            errors.append({"filename": filename, "error": str(e)})
    
    return JSONResponse(content={
        "uploaded": results,
        "errors": errors,
        "total_uploaded": len(results),
        "total_errors": len(errors)
    })


@router.get("/")
async def list_files(include_generated: bool = False):
    """
    List uploaded files. Generated/comparison output files are excluded by default.
    """
    files = FileService.list_files()
    if not include_generated:
        files = [f for f in files if not f.get('is_generated', False)]
    return {"files": files, "count": len(files)}


@router.get("/{file_id}")
async def get_file_info(file_id: str):
    """
    Get information about a specific file
    """
    file_info = FileService.get_file_info(file_id)
    if not file_info:
        raise HTTPException(status_code=404, detail="File not found")
    return file_info


@router.get("/{file_id}/preview")
async def get_file_preview(file_id: str, rows: int = 100):
    """
    Get a preview of file data
    """
    preview = FileService.get_preview(file_id, rows)
    if not preview:
        raise HTTPException(status_code=404, detail="File not found")
    return preview


@router.get("/{file_id}/data")
async def get_file_data(file_id: str, offset: int = 0, limit: int = 0):
    """
    Get file data for table view.
    - limit <= 0 returns all rows from offset
    - limit > 0 returns a bounded window
    """
    data = FileService.get_data(file_id, offset=offset, limit=None if limit <= 0 else limit)
    if not data:
        raise HTTPException(status_code=404, detail="File not found")
    return data


@router.get("/{file_id}/columns")
async def get_file_columns(file_id: str):
    """
    Get column names and detected types
    """
    from app.services.cleaning_service import DataCleaningService
    
    df = FileService.get_dataframe(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    column_types = DataCleaningService.detect_column_types(df)
    
    return {
        "columns": df.columns.tolist(),
        "detected_types": column_types,
        "dtypes": {col: str(dtype) for col, dtype in df.dtypes.items()}
    }


@router.delete("/{file_id}")
async def delete_file(file_id: str):
    """
    Delete a file
    """
    if not FileService.delete_file(file_id):
        raise HTTPException(status_code=404, detail="File not found")
    return {"message": "File deleted successfully"}
