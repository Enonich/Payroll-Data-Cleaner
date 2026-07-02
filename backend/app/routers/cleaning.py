"""
Cleaning router - handles data cleaning endpoints
"""
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from typing import List, Optional, Dict, Any, Literal, Tuple
from pydantic import BaseModel, Field
from difflib import SequenceMatcher
import re
from rapidfuzz import fuzz as rapidfuzz_fuzz
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
    matching_mode: Literal["exact", "fuzzy", "first_last"] = "exact"
    fuzzy_threshold: float = Field(default=0.88, ge=0.0, le=1.0)
    # Required when matching_mode == 'first_last'
    reference_first_name_column: Optional[str] = None
    reference_surname_column: Optional[str] = None


class RowUpdateItem(BaseModel):
    row_index: int
    values: Dict[str, Any]


class ApplyRowUpdatesRequest(BaseModel):
    file_id: str
    updates: List[RowUpdateItem]


class DeleteRowsRequest(BaseModel):
    file_id: str
    row_indices: List[int]


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


class FillSequenceRequest(BaseModel):
    file_id: str
    column_name: str
    prefix: str
    start_number: str
    overwrite_existing: bool = False


class AddColumnRequest(BaseModel):
    file_id: str
    column_name: str
    reference_column: Optional[str] = None
    position: Literal["left", "right", "end"] = "end"


def _normalize_name_for_match(value: Any) -> str:
    normalized = DataCleaningService.normalize_name_value(value)
    normalized = " ".join(str(normalized).strip().upper().split())
    return normalized


def _token_sort_name(name_key: str) -> str:
    """Return a token-sorted version of the name so that 'Abdulai Yusif'
    and 'Yusif Abdulai' collapse to the same key."""
    return " ".join(sorted(name_key.split()))


def _similarity_score(left: str, right: str) -> float:
    # token_sort_ratio is order-agnostic: 'A B' == 'B A'
    return rapidfuzz_fuzz.token_sort_ratio(left, right) / 100.0


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


def _extract_first_last(name_key: str) -> Tuple[str, str]:
    """Return the first and last tokens of a normalised name key.
    E.g. 'ABDULAI YUSIF KOFI MENSAH' → ('ABDULAI', 'MENSAH').
    Single-token names return the same token for both.
    """
    tokens = name_key.split()
    if not tokens:
        return "", ""
    if len(tokens) == 1:
        return tokens[0], tokens[0]
    return tokens[0], tokens[-1]


def _find_best_first_last_match(
    name_key: str,
    first_last_entries: List[Tuple[str, str, str]],  # (first, last, id)
    threshold: float,
) -> Tuple[Optional[str], Optional[float], Optional[str]]:
    """
    For each reference entry score how well its first and last name tokens
    appear individually among the target's tokens.
    Score = min(best_token_score_for_first, best_token_score_for_last)
    so *both* tokens must be present to score high.
    Returns (matched_id, score, display_label).
    When two entries tie above the threshold the match is considered
    ambiguous and (None, score, label) is returned.
    """
    if not name_key or not first_last_entries:
        return None, None, None

    target_tokens = name_key.split()
    if not target_tokens:
        return None, None, None

    best_id: Optional[str] = None
    best_score = 0.0
    best_label: Optional[str] = None
    is_ambiguous = False

    for ref_first, ref_last, ref_id in first_last_entries:
        if not ref_first:
            continue
        score_first = max(rapidfuzz_fuzz.ratio(ref_first, t) / 100.0 for t in target_tokens)
        score_last = max(rapidfuzz_fuzz.ratio(ref_last, t) / 100.0 for t in target_tokens)
        score = min(score_first, score_last)

        if score > best_score:
            best_score = score
            best_id = ref_id
            best_label = f"{ref_first} … {ref_last}"
            is_ambiguous = False
        elif score == best_score and score >= threshold and ref_id != best_id:
            is_ambiguous = True

    if best_id is None or best_score < threshold or is_ambiguous:
        return None, best_score, best_label

    return best_id, best_score, best_label


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


def insert_spaces_between_strings(expression: str, string_cols: set) -> str:
    # A regex to tokenize the expression.
    # Tokens can be:
    # - column references: `column_name`
    # - operator: +
    # - other operators/literals/spaces
    pattern = r"(`[^`]+`|\+|'[^\']*'|\"[^\"]*\"|[^\+`'\"]+)"
    tokens = re.findall(pattern, expression)
    
    new_tokens = []
    i = 0
    while i < len(tokens):
        token = tokens[i]
        stripped = token.strip()
        
        # If this token is a column reference and the next non-space token is '+'
        # and the token after that is another column reference, and both are string columns:
        if stripped.startswith('`') and stripped.endswith('`'):
            col_name = stripped[1:-1]
            if col_name in string_cols:
                # Look ahead for '+'
                next_plus_idx = -1
                next_col_idx = -1
                
                # find next non-empty token
                for j in range(i + 1, len(tokens)):
                    t_strip = tokens[j].strip()
                    if not t_strip:
                        continue
                    if t_strip == '+':
                        next_plus_idx = j
                        # Now look for the next column token after '+'
                        for k in range(j + 1, len(tokens)):
                            tk_strip = tokens[k].strip()
                            if not tk_strip:
                                continue
                            if tk_strip.startswith('`') and tk_strip.endswith('`'):
                                next_col_name = tk_strip[1:-1]
                                if next_col_name in string_cols:
                                    next_col_idx = k
                                break
                            else:
                                break
                        break
                    else:
                        break
                
                if next_plus_idx != -1 and next_col_idx != -1:
                    new_tokens.append(token)
                    for m in range(i + 1, next_plus_idx):
                        new_tokens.append(tokens[m])
                    new_tokens.append("+ ' ' +")
                    i = next_plus_idx + 1
                    continue
        
        new_tokens.append(token)
        i += 1
        
    return "".join(new_tokens)


def _compute_formula_series(df, expression: str):
    import pandas as pd
    referenced_cols = set(re.findall(r"`([^`]+)`", expression))
    eval_df = df.copy()
    
    numeric_cols = set()
    string_cols = set()
    
    for col in referenced_cols:
        if col in eval_df.columns:
            series = eval_df[col]
            non_nulls = series.dropna()
            is_num = False
            if len(non_nulls) > 0:
                if pd.api.types.is_numeric_dtype(series):
                    is_num = True
                else:
                    count_numeric = 0
                    count_to_check = min(len(non_nulls), 100)
                    for val in non_nulls.head(count_to_check):
                        val_str = str(val).strip()
                        if val_str in ('-', '', ' -   '):
                            count_numeric += 1
                            continue
                        val_str = val_str.replace(',', '').replace('"', '').replace('GH₵', '').replace('GHȼ', '')
                        try:
                            float(val_str)
                            count_numeric += 1
                        except ValueError:
                            pass
                    is_num = (count_numeric / count_to_check) >= 0.8
            
            if is_num:
                numeric_cols.add(col)
                eval_df[col] = eval_df[col].apply(DataCleaningService.clean_currency_value)
            else:
                string_cols.add(col)
                eval_df[col] = eval_df[col].fillna("").astype(str).str.strip()

    # Preprocess the expression to insert spaces between concatenated string columns
    expression = insert_spaces_between_strings(expression, string_cols)

    # Map backticked columns to temporary safe Python identifiers to evaluate using built-in eval()
    col_to_id = {}
    local_vars = {}
    temp_expression = expression
    
    for idx, col in enumerate(referenced_cols):
        col_id = f"__col_{idx}"
        col_to_id[col] = col_id
        if col in eval_df.columns:
            local_vars[col_id] = eval_df[col]
        else:
            local_vars[col_id] = 0
            
        temp_expression = temp_expression.replace(f"`{col}`", col_id)

    # Evaluate using native python eval
    result = eval(temp_expression, {"__builtins__": None}, local_vars)
    
    # If the result is string/object type, clean up multiple spaces
    if pd.api.types.is_object_dtype(result) or pd.api.types.is_string_dtype(result):
        result = result.fillna("").astype(str).str.replace(r'\s+', ' ', regex=True).str.strip()
        
    return result


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

    if request.matching_mode == "first_last":
        if not request.reference_first_name_column or not request.reference_surname_column:
            raise HTTPException(
                status_code=400,
                detail="'first_last' mode requires both reference_first_name_column and reference_surname_column.",
            )
        missing_fl = [
            c for c in [request.reference_first_name_column, request.reference_surname_column]
            if c not in reference_df.columns
        ]
        if missing_fl:
            raise HTTPException(
                status_code=400,
                detail=f"Reference file missing first/last name columns: {missing_fl}",
            )

    try:
        result_df = target_df.copy()
        if request.output_id_column not in result_df.columns:
            result_df[request.output_id_column] = ''

        reference_map: Dict[str, str] = {}
        duplicate_reference_names = set()

        for _, row in reference_df[[request.reference_name_column, request.reference_id_column]].iterrows():
            # Explicitly convert pandas/numpy values to Python scalars
            raw_name = row[request.reference_name_column]
            raw_id = row[request.reference_id_column]
            
            # Convert to native Python types
            if hasattr(raw_name, 'item'):
                raw_name = raw_name.item()
            if hasattr(raw_id, 'item'):
                raw_id = raw_id.item()
            
            name_key = _normalize_name_for_match(raw_name)
            id_value = DataCleaningService.normalize_staff_id(raw_id)

            if not name_key or not id_value:
                continue

            if name_key in reference_map and reference_map[name_key] != id_value:
                duplicate_reference_names.add(name_key)
                reference_map.pop(name_key, None)
                continue

            reference_map[name_key] = id_value

        # Build a secondary token-sorted map so that reversed names
        # (e.g. 'Abdulai Yusif' vs 'Yusif Abdulai') still match exactly.
        token_sort_map: Dict[str, str] = {}
        token_sort_conflicts: set = set()
        for _name_key, _id_value in reference_map.items():
            ts_key = _token_sort_name(_name_key)
            if ts_key in token_sort_conflicts:
                continue
            if ts_key in token_sort_map and token_sort_map[ts_key] != _id_value:
                token_sort_conflicts.add(ts_key)
                token_sort_map.pop(ts_key, None)
            else:
                token_sort_map[ts_key] = _id_value

        reference_names = list(reference_map.keys())

        # Build first+last entries for 'first_last' matching mode.
        # Uses the dedicated first-name and surname columns selected by the
        # user — more reliable than extracting tokens from the full name.
        first_last_entries: List[Tuple[str, str, str]] = []
        if request.matching_mode == "first_last":
            for _, ref_row in reference_df.iterrows():
                raw_fl_first = ref_row[request.reference_first_name_column]
                raw_fl_last  = ref_row[request.reference_surname_column]
                raw_fl_id    = ref_row[request.reference_id_column]
                if hasattr(raw_fl_first, 'item'): raw_fl_first = raw_fl_first.item()
                if hasattr(raw_fl_last,  'item'): raw_fl_last  = raw_fl_last.item()
                if hasattr(raw_fl_id,    'item'): raw_fl_id    = raw_fl_id.item()
                fl_first = _normalize_name_for_match(raw_fl_first)
                fl_last  = _normalize_name_for_match(raw_fl_last)
                fl_id    = DataCleaningService.normalize_staff_id(raw_fl_id)
                if fl_first and fl_last and fl_id:
                    first_last_entries.append((fl_first, fl_last, fl_id))

        fuzzy_cache: Dict[str, Tuple[Optional[str], Optional[float]]] = {}
        first_last_cache: Dict[str, Tuple[Optional[str], Optional[float], Optional[str]]] = {}

        matched = 0
        exact_matched = 0
        token_sort_matched = 0
        fuzzy_matched = 0
        first_last_matched = 0
        skipped_existing = 0
        unmatched = 0
        unmatched_samples = []
        fuzzy_match_samples = []
        first_last_match_samples = []

        for row_index, row in result_df.iterrows():
            # Explicitly convert pandas/numpy values to Python scalars
            raw_target_name = row[request.target_name_column]
            raw_existing_id = row.get(request.output_id_column)
            
            # Convert to native Python types
            if hasattr(raw_target_name, 'item'):
                raw_target_name = raw_target_name.item()
            if hasattr(raw_existing_id, 'item'):
                raw_existing_id = raw_existing_id.item()
            
            name_key = _normalize_name_for_match(raw_target_name)
            existing_id = DataCleaningService.normalize_staff_id(raw_existing_id)

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

            # Token-sort match: catches reversed names like 'Yusif Abdulai' vs 'Abdulai Yusif'
            ts_key = _token_sort_name(name_key)
            matched_id = token_sort_map.get(ts_key)
            if matched_id:
                result_df.at[row_index, request.output_id_column] = matched_id
                matched += 1
                token_sort_matched += 1
                continue

            # First+last match: checks whether the reference's first and surname
            # tokens both appear in the target's full name (handles middle-name
            # clutter or extra tokens that fool whole-name fuzzy matching).
            if request.matching_mode == "first_last":
                if name_key not in first_last_cache:
                    first_last_cache[name_key] = _find_best_first_last_match(
                        name_key,
                        first_last_entries,
                        request.fuzzy_threshold,
                    )
                fl_id, fl_score, fl_label = first_last_cache[name_key]
                if fl_id:
                    result_df.at[row_index, request.output_id_column] = fl_id
                    matched += 1
                    first_last_matched += 1
                    if len(first_last_match_samples) < 15:
                        first_last_match_samples.append({
                            "target_name": str(raw_target_name),
                            "matched_first_last": fl_label,
                            "score": round(float(fl_score or 0.0), 4),
                        })
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
                            "target_name": str(raw_target_name),
                            "matched_reference_name": best_name,
                            "score": round(float(best_score or 0.0), 4),
                        })
                    continue

            if request.matching_mode == "fuzzy" and name_key in fuzzy_cache:
                best_name, best_score = fuzzy_cache[name_key]
                if len(unmatched_samples) < 15:
                    unmatched_samples.append({
                        "target_name": str(raw_target_name),
                        "closest_reference_name": best_name,
                        "score": round(float(best_score or 0.0), 4),
                    })
            elif request.matching_mode == "first_last" and name_key in first_last_cache:
                _, fl_score, fl_label = first_last_cache[name_key]
                if len(unmatched_samples) < 15:
                    unmatched_samples.append({
                        "target_name": str(raw_target_name),
                        "closest_first_last": fl_label,
                        "score": round(float(fl_score or 0.0), 4),
                    })
            else:
                unmatched += 1
                if len(unmatched_samples) < 15:
                    unmatched_samples.append(str(raw_target_name))
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
                "token_sort_matched_rows": token_sort_matched,
                "fuzzy_matched_rows": fuzzy_matched,
                "first_last_matched_rows": first_last_matched,
                "skipped_existing_ids": skipped_existing,
                "unmatched_rows": unmatched,
                "reference_unique_names": len(reference_map),
                "reference_name_conflicts": len(duplicate_reference_names),
                "matching_mode": request.matching_mode,
                "fuzzy_threshold": request.fuzzy_threshold,
            },
            "unmatched_name_samples": unmatched_samples,
            "fuzzy_match_samples": fuzzy_match_samples,
            "first_last_match_samples": first_last_match_samples,
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


@router.post("/delete-rows")
async def delete_rows(request: DeleteRowsRequest):
    """
    Delete specific rows by their integer index positions.
    The dataframe is reset-indexed after deletion so future indices are stable.
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    if not request.row_indices:
        raise HTTPException(status_code=400, detail="No row indices supplied")

    out_of_range = [i for i in request.row_indices if i < 0 or i >= len(df)]
    if out_of_range:
        raise HTTPException(
            status_code=400,
            detail=f"Row indices out of range: {out_of_range}"
        )

    try:
        original_count = len(df)
        result_df = df.drop(index=request.row_indices).reset_index(drop=True)
        FileService.update_dataframe(request.file_id, result_df)
        preview = FileService.get_preview(request.file_id, 50)
        return {
            "message": "Rows deleted",
            "rows_deleted": original_count - len(result_df),
            "remaining_rows": len(result_df),
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


@router.post("/fill-sequence")
async def fill_sequence(request: FillSequenceRequest):
    """
    Populate a column with a sequential ID (prefix + auto-incrementing number).
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
        prefix = request.prefix or ""
        start_str = request.start_number.strip()
        
        # Determine starting number and padding width
        if start_str.isdigit():
            start_val = int(start_str)
            width = len(start_str)
        else:
            # extract trailing numeric part
            match = re.search(r'(\d+)$', start_str)
            if match:
                num_str = match.group(1)
                start_val = int(num_str)
                width = len(num_str)
                # prepend the non-numeric part of start_str to prefix
                prefix = prefix + start_str[:-width]
            else:
                raise HTTPException(
                    status_code=400,
                    detail="First Employee ID must contain a numeric component at the end (e.g. '001', '1001')"
                )

        # Generate sequence values
        num_rows = len(df)
        seq_values = []
        for i in range(num_rows):
            current_num = start_val + i
            num_part = f"{current_num:0{width}d}"
            seq_values.append(f"{prefix}{num_part}")

        result_df = df.copy()
        result_df[column_name] = seq_values

        FileService.update_dataframe(request.file_id, result_df)
        return {
            "message": "Sequence populated successfully",
            "column_name": column_name,
            "prefix": request.prefix,
            "start_number": request.start_number,
            "columns": result_df.columns.tolist(),
            "preview": FileService.get_preview(request.file_id, 30),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/add-column")
async def add_column(request: AddColumnRequest):
    """
    Add an empty column and place it to the left/right of a reference column.
    """
    df = FileService.get_dataframe(request.file_id)
    if df is None:
        raise HTTPException(status_code=404, detail="File not found")

    column_name = (request.column_name or "").strip()
    if not column_name:
        raise HTTPException(status_code=400, detail="column_name is required")

    if column_name in df.columns:
        raise HTTPException(status_code=400, detail=f"Column '{column_name}' already exists")

    try:
        result_df = df.copy()

        insert_at = len(result_df.columns)
        if request.position in ("left", "right"):
            if not request.reference_column:
                raise HTTPException(status_code=400, detail="reference_column is required for left/right insert")
            if request.reference_column not in result_df.columns:
                raise HTTPException(status_code=400, detail=f"Column '{request.reference_column}' not found")

            ref_idx = result_df.columns.get_loc(request.reference_column)
            insert_at = ref_idx if request.position == "left" else ref_idx + 1

        result_df.insert(insert_at, column_name, '')
        FileService.update_dataframe(request.file_id, result_df)

        return {
            "message": "Column added",
            "column_name": column_name,
            "position": request.position,
            "reference_column": request.reference_column,
            "columns": result_df.columns.tolist(),
            "preview": FileService.get_preview(request.file_id, 30),
        }
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


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
