"""
Template management and inference endpoints.
"""
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.file_service import FileService
from app.services.import_template_service import ImportTemplateService
from app.services.pipeline_service import FormulaRegistry, TRANSFORM_REGISTRY

router = APIRouter()


class TemplateCreateRequest(BaseModel):
    name: str
    target_system: str
    import_type: str = "generic_import"
    definition: Dict[str, Any]


class TemplateUpdateRequest(BaseModel):
    name: Optional[str] = None
    target_system: Optional[str] = None
    import_type: Optional[str] = None
    definition: Optional[Dict[str, Any]] = None


class TemplateInferRequest(BaseModel):
    file_id: str
    name: str
    target_system: str
    import_type: str = "generic_import"
    known_target_fields: Optional[List[str]] = None


@router.post("/")
async def create_template(request: TemplateCreateRequest):
    try:
        created = ImportTemplateService.create_template(request.model_dump())
        return {"message": "Template created", "template": created}
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))


@router.get("/registry/transforms")
async def list_transform_registry():
    return {"transforms": TRANSFORM_REGISTRY}


@router.get("/registry/formulas")
async def list_formula_registry():
    return {"formulas": FormulaRegistry.REGISTRY}


@router.get("/")
async def list_templates():
    templates = ImportTemplateService.list_templates()
    summary = [
        {
            "id": t["id"],
            "name": t["name"],
            "target_system": t["target_system"],
            "import_type": t["import_type"],
            "updated_at": t["updated_at"],
        }
        for t in templates
    ]
    return {"templates": summary, "count": len(summary)}


@router.get("/{template_id}")
async def get_template(template_id: str):
    template = ImportTemplateService.get_template(template_id)
    if not template:
        raise HTTPException(status_code=404, detail="Template not found")
    return template


@router.patch("/{template_id}")
async def update_template(template_id: str, request: TemplateUpdateRequest):
    updates = {k: v for k, v in request.model_dump().items() if v is not None}
    try:
        updated = ImportTemplateService.update_template(template_id, updates)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    if not updated:
        raise HTTPException(status_code=404, detail="Template not found")
    return {"message": "Template updated", "template": updated}


@router.delete("/{template_id}")
async def delete_template(template_id: str):
    if not ImportTemplateService.delete_template(template_id):
        raise HTTPException(status_code=404, detail="Template not found")
    return {"message": "Template deleted"}


@router.post("/infer")
async def infer_template(request: TemplateInferRequest):
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    suggested = ImportTemplateService.infer_template(
        df,
        request.name,
        request.target_system,
        request.import_type,
        request.known_target_fields,
    )

    sample_rows = df.head(10).to_dict(orient="records")
    return {
        "detected_columns": df.columns.tolist(),
        "sample_rows": sample_rows,
        "suggested_template": suggested,
    }
