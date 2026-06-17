"""
Cleaning router - handles data cleaning endpoints
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Optional, Dict, Any, Literal, Tuple
from pydantic import BaseModel, Field
from difflib import SequenceMatcher
import re
from app.services.file_service import FileService
from app.services.cleaning_service import DataCleaningService
from app.services.step_matching_service import StepMatchingService

router = APIRouter()


class CleaningRequest(BaseModel):
    file_id: str
    strip_whitespace: bool = True
    staff_id_column: Optional[str] = None
    currency_columns: Optional[List[str]] = None
    grade_column: Optional[str] = None
    branch_column: Optional[str] = None


class NormalizeIdsRequest(BaseModel):
    file_id: str
    id_column: str


class CleanCurrencyRequest(BaseModel):
    file_id: str
    columns: List[str]


class GradeNormalizationRequest(BaseModel):
    file_id: str
    grade_column: str


class StepMatchingRequest(BaseModel):
    employee_file_id: str
    salary_scale_file_id: str
    grade_column: str
    salary_column: str
    scale_grade_column: Optional[str] = None


class ColumnOperation(BaseModel):
    column: str
    operation: str  # normalize_staff_id | clean_currency | normalize_grade | fix_branch |
                    # strip_whitespace | uppercase | lowercase | titlecase | remove_nulls
    params: Optional[dict] = None


class ApplyOperationsRequest(BaseModel):
    file_id: str
    operations: List[ColumnOperation]
    strip_column_names: bool = False


class EnrichIdsByNameRequest(BaseModel):
    target_file_id: str
    reference_file_id: str
    target_name_column: str
    reference_name_column: str
    reference_id_column: str
    output_id_column: str = "Staff ID"
    overwrite_existing: bool = False
    matching_mode: Literal["exact", "fuzzy"] = "exact"
    fuzzy_threshold: float = Field(default=0.88, ge=0.0, le=1.0)


class RowUpdateItem(BaseModel):
    row_index: int
    values: Dict[str, Any]


class ApplyRowUpdatesRequest(BaseModel):
    file_id: str
    updates: List[RowUpdateItem]


class ReorderColumnsRequest(BaseModel):
    file_id: str
    column_order: List[str]


class DeleteColumnRequest(BaseModel):
    file_id: str
    column_name: str


class AddFormulaColumnRequest(BaseModel):
    file_id: str
    column_name: str
    formula: str
    overwrite_existing: bool = False


def _normalize_name_for_match(value: Any) -> str:
    normalized = DataCleaningService.normalize_name_value(value)
    normalized = " ".join(str(normalized).strip().upper().split())
    return normalized


def _similarity_score(left: str, right: str) -> float:
    return SequenceMatcher(None, left, right).ratio()


def _find_best_fuzzy_match(
    name_key: str,
    reference_names: List[str],
    threshold: float,
) -> Tuple[Optional[str], Optional[float]]:
    if not name_key or not reference_names:
        return None, None

    best_name = None
    best_score = 0.0
    for candidate in reference_names:
        score = _similarity_score(name_key, candidate)
        if score > best_score:
            best_score = score
            best_name = candidate

    if best_name is None or best_score < threshold:
        return None, best_score

    return best_name, best_score


def _build_eval_expression(formula: str, columns: List[str]) -> str:
    expression = str(formula or "").strip()
    if not expression:
        raise ValueError("Formula cannot be empty")

    # Allow explicit [Column Name] references.
    bracket_refs = re.findall(r"\[([^\]]+)\]", expression)
    for ref in bracket_refs:
        if ref not in columns:
            raise ValueError(f"Unknown column in formula: {ref}")
        expression = expression.replace(f"[{ref}]", f"`{ref}`")

    # If user wrote raw column names (e.g., Base Salary + Bonus), auto-wrap matched names.
    if "`" not in expression:
        for col in sorted(columns, key=len, reverse=True):
            pattern = re.escape(col)
            expression = re.sub(pattern, f"`{col}`", expression)

    return expression


def _compute_formula_series(df, expression: str):
    referenced_cols = set(re.findall(r"`([^`]+)`", expression))
    eval_df = df.copy()
    for col in referenced_cols:
        if col in eval_df.columns:
            eval_df[col] = eval_df[col].apply(DataCleaningService.clean_currency_value)
    return eval_df.eval(expression, engine="python")


@router.post("/apply-operations")
async def apply_column_operations(request: ApplyOperationsRequest):
    """
    Apply a list of per-column operations in order.
    Each operation specifies a column and a named transformation.
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    try:
        result_df = df.copy()

        if request.strip_column_names:
            result_df = DataCleaningService.strip_column_names(result_df)

        summary = []
        for op in request.operations:
            try:
                result_df, changes = DataCleaningService.apply_operation(
                    result_df, op.column, op.operation, op.params
                )
                summary.append({
                    "column": op.column,
                    "operation": op.operation,
                    "changes": changes,
                    "status": "success",
                })
            except ValueError as e:
                summary.append({
                    "column": op.column,
                    "operation": op.operation,
                    "changes": 0,
                    "status": "error",
                    "error": str(e),
                })

        FileService.update_dataframe(request.file_id, result_df)

        return {
            "message": f"Applied {len(request.operations)} operation(s)",
            "total_changes": sum(s["changes"] for s in summary),
            "summary": summary,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/enrich-ids-by-name")
async def enrich_ids_by_name(request: EnrichIdsByNameRequest):
    """
    Create or update an ID column in the target file by matching employee names
    against a reference file that already has the correct IDs.
    """
    target_df = FileService.get_dataframe(request.target_file_id)
    if target_df is None:
        raise HTTPException(status_code=404, detail="Target file not found")

    reference_df = FileService.get_dataframe(request.reference_file_id)
    if reference_df is None:
        raise HTTPException(status_code=404, detail="Reference file not found")

    required_target = [request.target_name_column]
    required_reference = [request.reference_name_column, request.reference_id_column]

    missing_target = [c for c in required_target if c not in target_df.columns]
    missing_reference = [c for c in required_reference if c not in reference_df.columns]
    if missing_target or missing_reference:
        details = []
        if missing_target:
            details.append(f"Target file missing columns: {missing_target}")
        if missing_reference:
            details.append(f"Reference file missing columns: {missing_reference}")
        raise HTTPException(status_code=400, detail="; ".join(details))

    try:
        result_df = target_df.copy()
        if request.output_id_column not in result_df.columns:
            result_df[request.output_id_column] = ''

        reference_map: Dict[str, str] = {}
        duplicate_reference_names = set()

        for _, row in reference_df[[request.reference_name_column, request.reference_id_column]].iterrows():
            raw_name = row[request.reference_name_column]
            raw_id = row[request.reference_id_column]
            name_key = _normalize_name_for_match(raw_name)
            id_value = DataCleaningService.normalize_staff_id(raw_id)

            if not name_key or not id_value:
                continue

            if name_key in reference_map and reference_map[name_key] != id_value:
                duplicate_reference_names.add(name_key)
                reference_map.pop(name_key, None)
                continue

            reference_map[name_key] = id_value

        reference_names = list(reference_map.keys())
        fuzzy_cache: Dict[str, Tuple[Optional[str], Optional[float]]] = {}

        matched = 0
        exact_matched = 0
        fuzzy_matched = 0
        skipped_existing = 0
        unmatched = 0
        unmatched_samples = []
        fuzzy_match_samples = []

        for row_index, row in result_df.iterrows():
            name_key = _normalize_name_for_match(row[request.target_name_column])
            existing_id = DataCleaningService.normalize_staff_id(row.get(request.output_id_column))

            if not name_key:
                unmatched += 1
                continue

            if existing_id and not request.overwrite_existing:
                skipped_existing += 1
                continue

            matched_id = reference_map.get(name_key)
            if matched_id:
                result_df.at[row_index, request.output_id_column] = matched_id
                matched += 1
                exact_matched += 1
                continue

            if request.matching_mode == "fuzzy":
                if name_key not in fuzzy_cache:
                    fuzzy_cache[name_key] = _find_best_fuzzy_match(
                        name_key,
                        reference_names,
                        request.fuzzy_threshold,
                    )

                best_name, best_score = fuzzy_cache[name_key]
                if best_name:
                    result_df.at[row_index, request.output_id_column] = reference_map[best_name]
                    matched += 1
                    fuzzy_matched += 1
                    if len(fuzzy_match_samples) < 15:
                        fuzzy_match_samples.append({
                            "target_name": str(row[request.target_name_column]),
                            "matched_reference_name": best_name,
                            "score": round(float(best_score or 0.0), 4),
                        })
                    continue

            if request.matching_mode == "fuzzy" and name_key in fuzzy_cache:
                best_name, best_score = fuzzy_cache[name_key]
                if len(unmatched_samples) < 15:
                    unmatched_samples.append({
                        "target_name": str(row[request.target_name_column]),
                        "closest_reference_name": best_name,
                        "score": round(float(best_score or 0.0), 4),
                    })
            else:
                unmatched += 1
                if len(unmatched_samples) < 15:
                    unmatched_samples.append(str(row[request.target_name_column]))
                continue

            unmatched += 1

        FileService.update_dataframe(request.target_file_id, result_df)
        preview = FileService.get_preview(request.target_file_id, 30)

        return {
            "message": "ID enrichment completed",
            "output_id_column": request.output_id_column,
            "stats": {
                "total_target_rows": len(result_df),
                "matched_rows": matched,
                "exact_matched_rows": exact_matched,
                "fuzzy_matched_rows": fuzzy_matched,
                "skipped_existing_ids": skipped_existing,
                "unmatched_rows": unmatched,
                "reference_unique_names": len(reference_map),
                "reference_name_conflicts": len(duplicate_reference_names),
                "matching_mode": request.matching_mode,
                "fuzzy_threshold": request.fuzzy_threshold,
            },
            "unmatched_name_samples": unmatched_samples,
            "fuzzy_match_samples": fuzzy_match_samples,
            "preview": preview,
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/update-rows")
async def apply_row_updates(request: ApplyRowUpdatesRequest):
    """
    Apply row-level field updates to specific rows in a file.
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    if not request.updates:
        raise HTTPException(status_code=400, detail="No row updates supplied")

    try:
        result_df = df.copy()
        updated_cells = 0

        for item in request.updates:
            if item.row_index < 0 or item.row_index >= len(result_df):
                raise HTTPException(
                    status_code=400,
                    detail=f"row_index out of range: {item.row_index}"
                )

            for field, new_value in item.values.items():
                if field not in result_df.columns:
                    raise HTTPException(
                        status_code=400,
                        detail=f"Column '{field}' not found"
                    )

                current_value = result_df.at[item.row_index, field]
                if str(current_value) != str(new_value):
                    result_df.at[item.row_index, field] = new_value
                    updated_cells += 1

        FileService.update_dataframe(request.file_id, result_df)
        preview = FileService.get_preview(request.file_id, 50)

        return {
            "message": "Row updates applied",
            "rows_touched": len(request.updates),
            "cells_updated": updated_cells,
            "preview": preview,
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/reorder-columns")
async def reorder_columns(request: ReorderColumnsRequest):
    """
    Reorder columns by drag-and-drop sequence.
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    existing = df.columns.tolist()
    provided = request.column_order or []
    if set(existing) != set(provided) or len(existing) != len(provided):
        raise HTTPException(
            status_code=400,
            detail="column_order must include all columns exactly once"
        )

    try:
        result_df = df[provided]
        FileService.update_dataframe(request.file_id, result_df)
        return {
            "message": "Columns reordered",
            "columns": result_df.columns.tolist(),
            "preview": FileService.get_preview(request.file_id, 30),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/delete-column")
async def delete_column(request: DeleteColumnRequest):
    """
    Delete a column from the file.
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    if request.column_name not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{request.column_name}' not found")

    if len(df.columns) <= 1:
        raise HTTPException(status_code=400, detail="Cannot delete the only remaining column")

    try:
        result_df = df.drop(columns=[request.column_name])
        FileService.update_dataframe(request.file_id, result_df)
        return {
            "message": "Column deleted",
            "deleted_column": request.column_name,
            "columns": result_df.columns.tolist(),
            "preview": FileService.get_preview(request.file_id, 30),
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/add-formula-column")
async def add_formula_column(request: AddFormulaColumnRequest):
    """
    Add a computed column based on a formula using other columns.
    Use [Column Name] for columns with spaces, e.g. [Base Salary] + [Bonus].
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    column_name = (request.column_name or "").strip()
    if not column_name:
        raise HTTPException(status_code=400, detail="column_name is required")

    if column_name in df.columns and not request.overwrite_existing:
        raise HTTPException(
            status_code=400,
            detail=f"Column '{column_name}' already exists. Enable overwrite_existing to replace it."
        )

    try:
        expression = _build_eval_expression(request.formula, df.columns.tolist())
        result_df = df.copy()
        result_df[column_name] = _compute_formula_series(result_df, expression)

        FileService.update_dataframe(request.file_id, result_df)
        return {
            "message": "Formula column added",
            "column_name": column_name,
            "formula": request.formula,
            "resolved_expression": expression,
            "columns": result_df.columns.tolist(),
            "preview": FileService.get_preview(request.file_id, 30),
        }
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(
            status_code=400,
            detail=f"Could not evaluate formula. Use [Column Name] for columns with spaces. Error: {str(e)}"
        )


@router.get("/{file_id}/column-values/{column}")
async def get_column_values(file_id: str, column: str, limit: int = 30):
    """
    Return unique sample values for a single column.
    Useful for previewing what a cleaning operation will affect.
    """
    df = FileService.get_dataframe(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    if column not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{column}' not found")

    unique_vals = df[column].dropna().unique()[:limit].tolist()
    return {
        "column": column,
        "unique_count": int(df[column].nunique()),
        "null_count": int(df[column].isna().sum()),
        "sample_values": [str(v) for v in unique_vals],
    }




@router.post("/clean")
async def clean_data(request: CleaningRequest):
    """
    Apply comprehensive data cleaning to a file
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    try:
        cleaned_df, changes = DataCleaningService.clean_dataframe(
            df,
            strip_columns=request.strip_whitespace,
            staff_id_column=request.staff_id_column,
            currency_columns=request.currency_columns,
            grade_column=request.grade_column,
            branch_column=request.branch_column
        )
        
        # Update the stored dataframe
        FileService.update_dataframe(request.file_id, cleaned_df)
        
        # Get preview of cleaned data
        preview = FileService.get_preview(request.file_id, 50)
        
        return {
            "message": "Data cleaned successfully",
            "changes": changes,
            "original_rows": len(df),
            "cleaned_rows": len(cleaned_df),
            "preview": preview
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Error cleaning data: {str(e)}")


@router.post("/normalize-ids")
async def normalize_staff_ids(request: NormalizeIdsRequest):
    """
    Normalize staff IDs in a column
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    if request.id_column not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{request.id_column}' not found")
    
    try:
        original = df[request.id_column].copy()
        cleaned_df = DataCleaningService.normalize_staff_ids_column(df, request.id_column)
        changes = (original.astype(str) != cleaned_df[request.id_column].astype(str)).sum()
        
        FileService.update_dataframe(request.file_id, cleaned_df)
        
        return {
            "message": "Staff IDs normalized",
            "column": request.id_column,
            "values_changed": int(changes),
            "sample_before": original.head(5).tolist(),
            "sample_after": cleaned_df[request.id_column].head(5).tolist()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/clean-currency")
async def clean_currency_columns(request: CleanCurrencyRequest):
    """
    Clean currency/numeric values in specified columns
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    missing_cols = [c for c in request.columns if c not in df.columns]
    if missing_cols:
        raise HTTPException(status_code=400, detail=f"Columns not found: {missing_cols}")
    
    try:
        changes = {}
        cleaned_df = df.copy()
        
        for col in request.columns:
            original = cleaned_df[col].copy()
            cleaned_df = DataCleaningService.clean_currency_column(cleaned_df, col)
            changes[col] = int((original.astype(str) != cleaned_df[col].astype(str)).sum())
        
        FileService.update_dataframe(request.file_id, cleaned_df)
        
        return {
            "message": "Currency columns cleaned",
            "changes_per_column": changes,
            "total_changes": sum(changes.values())
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/normalize-grades")
async def normalize_grades(request: GradeNormalizationRequest):
    """
    Normalize grade/rank names in a column
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    if request.grade_column not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{request.grade_column}' not found")
    
    try:
        original = df[request.grade_column].copy()
        cleaned_df = DataCleaningService.normalize_grades_column(df, request.grade_column)
        changes = (original != cleaned_df[request.grade_column]).sum()
        
        # Get unique grades before and after
        unique_before = original.nunique()
        unique_after = cleaned_df[request.grade_column].nunique()
        
        FileService.update_dataframe(request.file_id, cleaned_df)
        
        return {
            "message": "Grades normalized",
            "column": request.grade_column,
            "values_changed": int(changes),
            "unique_before": unique_before,
            "unique_after": unique_after,
            "sample_grades": cleaned_df[request.grade_column].unique()[:20].tolist()
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/match-steps")
async def match_salary_steps(request: StepMatchingRequest):
    """
    Match employees to salary scale steps based on grade and salary
    """
    emp_df = FileService.get_dataframe(request.employee_file_id)
    if emp_df is None:
        raise HTTPException(status_code=404, detail="Employee file not found")
    
    scale_df = FileService.get_dataframe(request.salary_scale_file_id)
    if scale_df is None:
        raise HTTPException(status_code=404, detail="Salary scale file not found")
    
    if request.grade_column not in emp_df.columns:
        raise HTTPException(status_code=400, 
                          detail=f"Grade column '{request.grade_column}' not found in employee file")
    
    if request.salary_column not in emp_df.columns:
        raise HTTPException(status_code=400,
                          detail=f"Salary column '{request.salary_column}' not found in employee file")
    
    try:
        # Validate salary scale
        validation = StepMatchingService.validate_salary_scale(scale_df)
        if not validation['is_valid']:
            return {
                "error": "Invalid salary scale file",
                "issues": validation['issues']
            }
        
        # Perform matching
        result_df, stats = StepMatchingService.match_employees_to_steps(
            emp_df,
            scale_df,
            request.grade_column,
            request.salary_column,
            request.scale_grade_column
        )
        
        # Create a new file with results
        new_file_id = FileService.create_new_file(
            result_df,
            f"employees_with_steps.csv"
        )
        
        # Get unmatched analysis
        if stats['unmatched'] > 0:
            unmatched_analysis = StepMatchingService.analyze_unmatched_employees(
                result_df, request.grade_column
            )
            stats['unmatched_by_grade'] = unmatched_analysis.to_dict('records')
        
        return {
            "message": "Step matching completed",
            "result_file_id": new_file_id,
            "statistics": stats,
            "preview": FileService.get_preview(new_file_id, 20)
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/{file_id}/detect-types")
async def detect_column_types(file_id: str):
    """
    Detect column types for a file
    """
    df = FileService.get_dataframe(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    types = DataCleaningService.detect_column_types(df)
    
    return {
        "detected_types": types,
        "recommendations": {
            "staff_id": [c for c, t in types.items() if t == 'staff_id'],
            "currency": [c for c, t in types.items() if t == 'currency'],
            "grade": [c for c, t in types.items() if t == 'grade'],
            "branch": [c for c, t in types.items() if t == 'branch']
        }
    }


@router.post("/{file_id}/filter-numeric-ids")
async def filter_numeric_ids(file_id: str, id_column: str):
    """
    Filter out rows with non-numeric IDs
    """
    df = FileService.get_dataframe(file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")
    
    if id_column not in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{id_column}' not found")
    
    try:
        original_count = len(df)
        filtered_df = DataCleaningService.filter_numeric_ids(df, id_column)
        filtered_count = len(filtered_df)
        
        FileService.update_dataframe(file_id, filtered_df)
        
        return {
            "message": "Non-numeric IDs filtered",
            "original_rows": original_count,
            "remaining_rows": filtered_count,
            "removed_rows": original_count - filtered_count
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))
