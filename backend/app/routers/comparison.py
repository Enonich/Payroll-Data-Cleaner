"""
Comparison router - handles payroll comparison endpoints
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Optional, Dict, Any
from pydantic import BaseModel
from app.services.file_service import FileService
from app.services.comparison_service import ComparisonService
from app.services.ai_comparison_service import AIComparisonService
from app.services.template_service import TemplateService
from app.services.reconciliation_service import ReconciliationService

router = APIRouter()


def _normalized_column_name(column: str) -> str:
    return ''.join(ch.lower() if ch.isalnum() else ' ' for ch in str(column)).strip()


def _find_column_by_aliases(df, aliases: List[str]) -> Optional[str]:
    normalized = {
        ' '.join(_normalized_column_name(col).split()): col
        for col in df.columns
    }
    compact = {
        key.replace(' ', ''): col
        for key, col in normalized.items()
    }
    for alias in aliases:
        key = ' '.join(_normalized_column_name(alias).split())
        if key in normalized:
            return normalized[key]
        if key.replace(' ', '') in compact:
            return compact[key.replace(' ', '')]
    return None


def _resolve_name_column(df, selected_column: Optional[str], side: str) -> Optional[str]:
    if selected_column and selected_column in df.columns:
        return selected_column

    full_name = _find_column_by_aliases(df, ["name of employee", "employee name", "full name", "name"])
    if full_name:
        return full_name

    first = _find_column_by_aliases(df, ["firstname", "first name"])
    surname = _find_column_by_aliases(df, ["surname", "last name"])
    other = _find_column_by_aliases(df, ["other name", "middle name"])
    if first and surname:
        derived = f"_comparison_full_name_{side}"
        parts = [first]
        if other:
            parts.append(other)
        parts.append(surname)
        df[derived] = df[parts].fillna("").astype(str).agg(" ".join, axis=1).str.strip()
        return derived

    return None


def _ensure_name_mapping(
    column_mappings: List[Dict[str, Any]],
    name_col1: Optional[str],
    name_col2: Optional[str],
) -> List[Dict[str, Any]]:
    mappings = [mapping.copy() for mapping in column_mappings]
    if not name_col1 or not name_col2:
        return mappings
    has_name_mapping = any(
        str(mapping.get("label") or mapping.get("field") or "").strip().lower() == "name"
        or mapping.get("type") == "name"
        for mapping in mappings
    )
    if not has_name_mapping:
        mappings.insert(0, {
            "file1": name_col1,
            "file2": name_col2,
            "label": "Name",
            "type": "name",
        })
    return mappings


class SalaryComparisonRequest(BaseModel):
    file1_id: str
    file2_id: str
    id_col1: str
    id_col2: str
    salary_col1: str
    salary_col2: str
    name_col1: Optional[str] = None
    name_col2: Optional[str] = None
    normalize_ids: bool = True
    keep_digits: int = 5
    tolerance: float = 0.01


class EmployeePresenceRequest(BaseModel):
    file1_id: str
    file2_id: str
    id_col1: str
    id_col2: str
    normalize_ids: bool = True
    keep_digits: int = 5


class MultiColumnComparisonRequest(BaseModel):
    file1_id: str
    file2_id: str
    id_col1: str
    id_col2: str
    column_mappings: List[Dict[str, str]]  # [{"file1": "Basic", "file2": "Basic Salary"}]
    normalize_ids: bool = True


class EmployeeDataComparisonRequest(BaseModel):
    file1_id: str
    file2_id: str
    id_col1: str
    id_col2: str
    column_mappings: List[Dict[str, str]]
    name_col1: Optional[str] = None
    name_col2: Optional[str] = None
    normalize_ids: bool = True
    keep_digits: int = 5
    tolerance: float = 0.01
    use_ai: bool = True
    # Optional user-supplied column role overrides:
    # keys are column labels, values are 'allowance' | 'deduction' | 'earning'
    column_roles: Optional[Dict[str, str]] = None


class AllowanceDeductionRequest(BaseModel):
    file_id: str
    staff_id_column: str
    value_columns: List[str]
    template_type: str = "allowance"  # or "deduction"


@router.post("/salary")
async def compare_salaries(request: SalaryComparisonRequest):
    """
    Compare salaries between two files
    """
    df1 = FileService.get_dataframe(request.file1_id)
    if df1 is None:
        raise HTTPException(status_code=404, detail="File 1 not found")
    
    df2 = FileService.get_dataframe(request.file2_id)
    if df2 is None:
        raise HTTPException(status_code=404, detail="File 2 not found")
    
    # Validate columns exist
    for col, df, name in [(request.id_col1, df1, "File 1"), 
                          (request.salary_col1, df1, "File 1"),
                          (request.id_col2, df2, "File 2"),
                          (request.salary_col2, df2, "File 2")]:
        if col not in df.columns:
            raise HTTPException(status_code=400, 
                              detail=f"Column '{col}' not found in {name}")
    
    try:
        result = ComparisonService.compare_salaries(
            df1, df2,
            request.id_col1, request.id_col2,
            request.salary_col1, request.salary_col2,
            request.name_col1, request.name_col2,
            request.normalize_ids, request.keep_digits,
            request.tolerance
        )
        
        # Create result files
        files_created = {}
        
        if len(result['with_difference_df']) > 0:
            file_id = FileService.create_new_file(
                result['with_difference_df'],
                "salary_differences.csv"
            )
            files_created['with_differences'] = file_id
        
        if len(result['no_difference_df']) > 0:
            file_id = FileService.create_new_file(
                result['no_difference_df'],
                "salary_no_differences.csv"
            )
            files_created['no_differences'] = file_id
        
        if len(result['only_in_file1_df']) > 0:
            file_id = FileService.create_new_file(
                result['only_in_file1_df'],
                "only_in_file1.csv"
            )
            files_created['only_in_file1'] = file_id
        
        if len(result['only_in_file2_df']) > 0:
            file_id = FileService.create_new_file(
                result['only_in_file2_df'],
                "only_in_file2.csv"
            )
            files_created['only_in_file2'] = file_id
        
        # Generate report
        report = ComparisonService.generate_comparison_report(result)
        
        return {
            "summary": {
                "total_file1": result['total_file1'],
                "total_file2": result['total_file2'],
                "matched": result['matched'],
                "only_in_file1": result['only_in_file1'],
                "only_in_file2": result['only_in_file2'],
                "with_differences": result['with_differences'],
                "without_differences": result['without_differences']
            },
            "statistics": result['statistics'],
            "files_created": files_created,
            "report": report,
            "preview_differences": result['with_difference_df'].head(20).to_dict('records')
            if len(result['with_difference_df']) > 0 else []
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/employees")
async def compare_employee_presence(request: EmployeePresenceRequest):
    """
    Find employees present in one or both files
    """
    df1 = FileService.get_dataframe(request.file1_id)
    if df1 is None:
        raise HTTPException(status_code=404, detail="File 1 not found")
    
    df2 = FileService.get_dataframe(request.file2_id)
    if df2 is None:
        raise HTTPException(status_code=404, detail="File 2 not found")
    
    if request.id_col1 not in df1.columns:
        raise HTTPException(status_code=400, 
                          detail=f"Column '{request.id_col1}' not found in File 1")
    if request.id_col2 not in df2.columns:
        raise HTTPException(status_code=400,
                          detail=f"Column '{request.id_col2}' not found in File 2")
    
    try:
        common, only1, only2 = ComparisonService.find_common_employees(
            df1, df2,
            request.id_col1, request.id_col2,
            request.normalize_ids, request.keep_digits
        )
        
        return {
            "common_employees": len(common),
            "only_in_file1": len(only1),
            "only_in_file2": len(only2),
            "total_file1": len(df1),
            "total_file2": len(df2),
            "sample_common": list(common)[:10] if len(common) <= 100 else f"{len(common)} IDs",
            "sample_only_file1": list(only1)[:10] if len(only1) <= 100 else f"{len(only1)} IDs",
            "sample_only_file2": list(only2)[:10] if len(only2) <= 100 else f"{len(only2)} IDs"
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/multi-column")
async def compare_multiple_columns(request: MultiColumnComparisonRequest):
    """
    Compare multiple columns between two files
    """
    df1 = FileService.get_dataframe(request.file1_id)
    if df1 is None:
        raise HTTPException(status_code=404, detail="File 1 not found")
    
    df2 = FileService.get_dataframe(request.file2_id)
    if df2 is None:
        raise HTTPException(status_code=404, detail="File 2 not found")
    
    try:
        results = ComparisonService.compare_multiple_columns(
            df1, df2,
            request.id_col1, request.id_col2,
            request.column_mappings,
            request.normalize_ids
        )
        
        return {
            "comparisons": results,
            "total_columns_compared": len(request.column_mappings)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/employee-data")
async def compare_employee_data(request: EmployeeDataComparisonRequest):
    """
    Compare employee data across two files and return field-level inconsistencies.
    """
    df1 = FileService.get_dataframe(request.file1_id)
    if df1 is None:
        raise HTTPException(status_code=404, detail="File 1 not found")

    df2 = FileService.get_dataframe(request.file2_id)
    if df2 is None:
        raise HTTPException(status_code=404, detail="File 2 not found")

    required_file1 = [request.id_col1] + [m.get('file1') for m in request.column_mappings]
    required_file2 = [request.id_col2] + [m.get('file2') for m in request.column_mappings]
    if request.name_col1:
        required_file1.append(request.name_col1)
    if request.name_col2:
        required_file2.append(request.name_col2)

    missing_file1 = [c for c in required_file1 if c and c not in df1.columns]
    missing_file2 = [c for c in required_file2 if c and c not in df2.columns]
    if missing_file1 or missing_file2:
        details = []
        if missing_file1:
            details.append(f"File 1 missing columns: {missing_file1}")
        if missing_file2:
            details.append(f"File 2 missing columns: {missing_file2}")
        raise HTTPException(status_code=400, detail="; ".join(details))

    if not request.column_mappings:
        raise HTTPException(status_code=400, detail="At least one column mapping is required")

    try:
        df1_compare = df1.copy()
        df2_compare = df2.copy()
        resolved_name_col1 = _resolve_name_column(df1_compare, request.name_col1, "file1")
        resolved_name_col2 = _resolve_name_column(df2_compare, request.name_col2, "file2")
        effective_mappings = _ensure_name_mapping(
            request.column_mappings,
            resolved_name_col1,
            resolved_name_col2,
        )

        matching_columns = ComparisonService.resolve_matching_columns(
            df1_compare,
            df2_compare,
            request.id_col1,
            request.id_col2,
            request.normalize_ids,
            request.keep_digits,
        )

        result = ComparisonService.compare_employee_data(
            df1_compare, df2_compare,
            matching_columns["id_col1"], matching_columns["id_col2"],
            effective_mappings,
            resolved_name_col1, resolved_name_col2,
            request.normalize_ids, matching_columns.get("keep_digits", request.keep_digits),
            request.tolerance
        )

        ai_audit = None
        if request.use_ai:
            ai_audit = AIComparisonService.generate_audit(result, column_roles=request.column_roles)

        files_created = {}
        if len(result['mismatches_df']) > 0:
            files_created['field_differences'] = FileService.create_new_file(
                result['mismatches_df'],
                "employee_field_differences.csv"
            )
        if len(result['only_in_file1_df']) > 0:
            files_created['only_in_file1'] = FileService.create_new_file(
                result['only_in_file1_df'],
                "employees_only_in_file1.csv"
            )
        if len(result['only_in_file2_df']) > 0:
            files_created['only_in_file2'] = FileService.create_new_file(
                result['only_in_file2_df'],
                "employees_only_in_file2.csv"
            )

        reconciliation_payload = None
        reconciliation_warning = None
        try:
            file1_info = FileService.get_file_info(request.file1_id) or {}
            file2_info = FileService.get_file_info(request.file2_id) or {}
            reconciliation_run = ReconciliationService.create_run_from_employee_data_result(
                request.file1_id,
                request.file2_id,
                file1_info.get("filename", "File 1"),
                file2_info.get("filename", "File 2"),
                result,
            )
            reconciliation_payload = {
                "id": reconciliation_run["id"],
                "status_counts": reconciliation_run["status_counts"],
                "type_counts": reconciliation_run["type_counts"],
                "issue_count": len(reconciliation_run["issues"]),
                "issues_preview": reconciliation_run["issues"][:20],
            }
        except Exception as reconciliation_error:
            reconciliation_warning = str(reconciliation_error)

        return {
            "summary": {
                "total_file1": result['total_file1'],
                "total_file2": result['total_file2'],
                "matched": result['matched'],
                "only_in_file1": result['only_in_file1'],
                "only_in_file2": result['only_in_file2'],
                "employees_with_differences": result['employees_with_differences'],
                "employees_without_differences": result['employees_without_differences'],
                "field_differences": result['field_differences'],
                "duplicate_ids_file1": result['duplicate_ids_file1'],
                "duplicate_ids_file2": result['duplicate_ids_file2'],
            },
            "duplicate_id_samples": {
                "file1": result['duplicate_id_samples_file1'],
                "file2": result['duplicate_id_samples_file2'],
            },
            "analytics": result['analytics'],
            "matching_columns": matching_columns,
            "name_columns": {
                "file1": resolved_name_col1,
                "file2": resolved_name_col2,
                "auto_mapped": bool(resolved_name_col1 and resolved_name_col2),
            },
            "presence_preview": {
                "only_in_file1": result['only_in_file1_preview'],
                "only_in_file2": result['only_in_file2_preview'],
            },
            "reconciliation_run": reconciliation_payload,
            "reconciliation_warning": reconciliation_warning,
            "ai_audit": ai_audit,
            "files_created": files_created,
            "preview_differences": result['mismatches_df'].head(50).to_dict('records')
            if len(result['mismatches_df']) > 0 else []
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/generate-allowances")
async def generate_allowance_files(request: AllowanceDeductionRequest):
    """
    Generate individual allowance files from a payroll file
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    if request.staff_id_column not in df.columns:
        raise HTTPException(status_code=400,
                          detail=f"Column '{request.staff_id_column}' not found")
    
    missing_cols = [c for c in request.value_columns if c not in df.columns]
    if missing_cols:
        raise HTTPException(status_code=400,
                          detail=f"Columns not found: {missing_cols}")
    
    try:
        if request.template_type == "allowance":
            results = TemplateService.generate_allowance_files(
                df, request.staff_id_column, request.value_columns
            )
        else:
            results = TemplateService.generate_deduction_files(
                df, request.staff_id_column, request.value_columns
            )
        
        # Create file entries for each result
        files_created = {}
        for name, result_df in results.items():
            if len(result_df) > 0:
                file_id = FileService.create_new_file(result_df, f"{name}.csv")
                files_created[name] = {
                    "file_id": file_id,
                    "records": len(result_df)
                }
        
        return {
            "message": f"Generated {len(files_created)} {request.template_type} files",
            "files": files_created
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{file_id}/identify-columns")
async def identify_allowance_deduction_columns(file_id: str):
    """
    Automatically identify potential allowance and deduction columns
    """
    df = FileService.get_dataframe(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    try:
        identification = TemplateService.identify_allowance_deduction_columns(df)
        return identification
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/employee-import-template")
async def generate_employee_import_template(
    file_id: str,
    staff_id_column: str,
    name_column: Optional[str] = None
):
    """
    Generate an employee import template from a file
    """
    df = FileService.get_dataframe(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    if staff_id_column not in df.columns:
        raise HTTPException(status_code=400,
                          detail=f"Column '{staff_id_column}' not found")
    
    try:
        import_df = TemplateService.generate_employee_import_template(
            df, staff_id_column, name_column
        )
        
        new_file_id = FileService.create_new_file(
            import_df,
            "employee_import_template.csv"
        )
        
        return {
            "message": "Employee import template generated",
            "file_id": new_file_id,
            "records": len(import_df),
            "preview": import_df.head(10).to_dict('records')
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
