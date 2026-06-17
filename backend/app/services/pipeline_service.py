"""
Template-driven cleaning and validation pipeline.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime
from typing import Any, Callable, Dict, List, Set, Tuple

import pandas as pd

from app.services.cleaning_service import DataCleaningService


@dataclass
class PipelineResult:
    dataframe: pd.DataFrame
    issues: List[Dict[str, Any]]


class FormulaRegistry:
    """Closed registry of formula functions."""

    @staticmethod
    def concat(args: List[Any], kwargs: Dict[str, Any]) -> str:
        sep = kwargs.get("separator", "")
        return sep.join(["" if a is None else str(a) for a in args])

    @staticmethod
    def concat_with_space(args: List[Any], kwargs: Dict[str, Any]) -> str:
        _ = kwargs
        return " ".join([str(a).strip() for a in args if a is not None and str(a).strip()])

    @staticmethod
    def age_years(args: List[Any], kwargs: Dict[str, Any]) -> Any:
        _ = kwargs
        if not args:
            return None
        date_val = DataCleaningService.parse_date(args[0])
        if not date_val:
            return None
        today = datetime.utcnow().date()
        return max(today.year - date_val.year - ((today.month, today.day) < (date_val.month, date_val.day)), 0)

    @staticmethod
    def tenure_years(args: List[Any], kwargs: Dict[str, Any]) -> Any:
        _ = kwargs
        if not args:
            return None
        start = DataCleaningService.parse_date(args[0])
        if not start:
            return None
        today = datetime.utcnow().date()
        return max(today.year - start.year - ((today.month, today.day) < (start.month, start.day)), 0)

    @staticmethod
    def upper(args: List[Any], kwargs: Dict[str, Any]) -> str:
        _ = kwargs
        return "" if not args or args[0] is None else str(args[0]).upper()

    @staticmethod
    def lower(args: List[Any], kwargs: Dict[str, Any]) -> str:
        _ = kwargs
        return "" if not args or args[0] is None else str(args[0]).lower()

    @staticmethod
    def title_case(args: List[Any], kwargs: Dict[str, Any]) -> str:
        _ = kwargs
        return "" if not args or args[0] is None else str(args[0]).title()

    FUNCTIONS: Dict[str, Callable[[List[Any], Dict[str, Any]], Any]] = {
        "concat": concat.__func__,
        "concat_with_space": concat_with_space.__func__,
        "age_years": age_years.__func__,
        "tenure_years": tenure_years.__func__,
        "upper": upper.__func__,
        "lower": lower.__func__,
        "title_case": title_case.__func__,
    }

    REGISTRY: List[Dict[str, Any]] = [
        {"name": "concat", "label": "Concatenate", "args_hint": "$field1,$field2", "kwargs": ["separator"]},
        {"name": "concat_with_space", "label": "Concat with space", "args_hint": "$first_name,$last_name", "kwargs": []},
        {"name": "age_years", "label": "Age in years", "args_hint": "$date_of_birth", "kwargs": []},
        {"name": "tenure_years", "label": "Tenure in years", "args_hint": "$hire_date", "kwargs": []},
        {"name": "upper", "label": "Uppercase", "args_hint": "$field", "kwargs": []},
        {"name": "lower", "label": "Lowercase", "args_hint": "$field", "kwargs": []},
        {"name": "title_case", "label": "Title case", "args_hint": "$field", "kwargs": []},
    ]


TRANSFORM_REGISTRY: List[Dict[str, Any]] = [
    {"name": "strip_whitespace", "label": "Strip whitespace", "params": []},
    {"name": "title_case", "label": "Title case", "params": []},
    {"name": "upper", "label": "Uppercase", "params": []},
    {"name": "lower", "label": "Lowercase", "params": []},
    {"name": "name_format", "label": "Name format (Last, First → First Last)", "params": []},
    {
        "name": "date_normalize",
        "label": "Date normalize",
        "params": [{"name": "output_format", "type": "string", "default": "%Y-%m-%d"}],
    },
    {"name": "id_pad", "label": "Pad ID with leading zeros", "params": [{"name": "width", "type": "number", "default": 6}]},
    {
        "name": "normalize_prefix",
        "label": "Normalize ID prefix",
        "params": [
            {"name": "from_prefix", "type": "string", "default": ""},
            {"name": "to_prefix", "type": "string", "default": ""},
        ],
    },
    {"name": "type_numeric", "label": "Coerce to numeric", "params": []},
    {"name": "type_date", "label": "Coerce to date", "params": []},
]


class PipelineService:
    """Executes template mapping, cleaning, formulas, and validation."""

    @staticmethod
    def _empty(value: Any) -> bool:
        return pd.isna(value) or str(value).strip() == ""

    @staticmethod
    def _issue(issue_type: str, row_index: int, field: str, message: str, severity: str = "error") -> Dict[str, Any]:
        return {
            "id": f"{issue_type}:{row_index}:{field}",
            "type": issue_type,
            "row_index": row_index,
            "field": field,
            "message": message,
            "severity": severity,
            "status": "open",
        }

    @staticmethod
    def _normalize_alias(alias: str) -> str:
        return alias.strip().lower().replace("_", " ")

    @classmethod
    def _find_source_column(cls, source_aliases: List[str], source_columns: List[str]) -> str | None:
        normalized_map = {cls._normalize_alias(col): col for col in source_columns}
        for alias in source_aliases:
            match = normalized_map.get(cls._normalize_alias(alias))
            if match:
                return match
        return None

    @staticmethod
    def _apply_transforms(value: Any, transforms: List[Dict[str, Any]]) -> Tuple[Any, List[str]]:
        errors: List[str] = []
        out = value
        for transform in transforms or []:
            if isinstance(transform, str):
                transform_name = transform
                params = {}
            else:
                transform_name = transform.get("name")
                params = transform.get("params", {})

            if transform_name == "strip_whitespace" and isinstance(out, str):
                out = out.strip()
            elif transform_name == "title_case" and isinstance(out, str):
                out = out.title()
            elif transform_name == "upper" and isinstance(out, str):
                out = out.upper()
            elif transform_name == "lower" and isinstance(out, str):
                out = out.lower()
            elif transform_name == "name_format":
                out = DataCleaningService.normalize_name_value(out)
            elif transform_name == "date_normalize":
                date_out = DataCleaningService.normalize_date_value(out, params.get("output_format", "%Y-%m-%d"))
                if out not in (None, "") and date_out is None:
                    errors.append("invalid_date")
                out = date_out
            elif transform_name == "id_pad":
                width = int(params.get("width", 0))
                out = DataCleaningService.pad_id_value(out, width)
            elif transform_name == "normalize_prefix":
                out = DataCleaningService.normalize_id_prefix(
                    out,
                    params.get("from_prefix", ""),
                    params.get("to_prefix", ""),
                )
            elif transform_name == "type_numeric":
                num = DataCleaningService.coerce_numeric_value(out)
                if out not in (None, "") and num is None:
                    errors.append("invalid_numeric")
                out = num
            elif transform_name == "type_date":
                date_only = DataCleaningService.parse_date(out)
                if out not in (None, "") and date_only is None:
                    errors.append("invalid_date")
                out = date_only.isoformat() if date_only else None
        return out, errors

    @classmethod
    def _collect_formula_dependencies(cls, formula: Dict[str, Any]) -> Set[str]:
        deps: Set[str] = set()
        for arg in formula.get("args", []):
            if isinstance(arg, str) and arg.startswith("$"):
                deps.add(arg[1:])
        return deps

    @classmethod
    def _topological_sort_formula_columns(cls, columns: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        formula_cols = [c for c in columns if c.get("formula")]
        by_target = {c["target_field"]: c for c in formula_cols}
        visiting: Set[str] = set()
        visited: Set[str] = set()
        ordered: List[Dict[str, Any]] = []

        def visit(node: str) -> None:
            if node in visited:
                return
            if node in visiting:
                raise ValueError(f"Circular formula dependency detected at '{node}'")
            visiting.add(node)
            col = by_target[node]
            for dep in cls._collect_formula_dependencies(col.get("formula", {})):
                if dep in by_target:
                    visit(dep)
            visiting.remove(node)
            visited.add(node)
            ordered.append(col)

        for key in by_target.keys():
            visit(key)
        return ordered

    @classmethod
    def process(cls, source_df: pd.DataFrame, definition: Dict[str, Any]) -> PipelineResult:
        columns: List[Dict[str, Any]] = definition.get("columns", [])
        required_fields = set(definition.get("required_fields", []))
        dedup_keys = definition.get("dedup_keys", [])

        source_df = source_df.copy()
        source_df.columns = [str(c).strip() for c in source_df.columns]

        issues: List[Dict[str, Any]] = []
        output_df = pd.DataFrame(index=source_df.index)

        # Map direct columns first in declared order.
        for col_rule in columns:
            if col_rule.get("formula"):
                continue

            target_field = col_rule["target_field"]
            source_col = cls._find_source_column(col_rule.get("source_aliases", []), source_df.columns.tolist())
            if source_col is None:
                issues.append(
                    cls._issue(
                        "missing_source_column",
                        -1,
                        target_field,
                        f"No source column found for aliases: {col_rule.get('source_aliases', [])}",
                    )
                )
                output_df[target_field] = None
                continue

            strict_map = bool(col_rule.get("strict_value_map", False))
            value_map: Dict[str, Any] = col_rule.get("value_map", {}) or {}
            transforms = col_rule.get("transforms", [])

            out_values = []
            for idx, raw_val in source_df[source_col].items():
                value = raw_val

                if isinstance(value, str):
                    value = value.strip()

                mapped_val = value
                if value_map and not cls._empty(value):
                    key = str(value)
                    if key in value_map:
                        mapped_val = value_map[key]
                    elif strict_map:
                        issues.append(
                            cls._issue(
                                "unmapped_value",
                                int(idx),
                                target_field,
                                f"Value '{value}' not found in mapping",
                            )
                        )

                transformed, transform_errors = cls._apply_transforms(mapped_val, transforms)
                for error_name in transform_errors:
                    issues.append(
                        cls._issue(
                            "invalid_format",
                            int(idx),
                            target_field,
                            f"Transformation failed ({error_name}) for value '{value}'",
                        )
                    )

                out_values.append(transformed)

            output_df[target_field] = out_values

        # Evaluate formula columns in dependency order.
        ordered_formula_columns = cls._topological_sort_formula_columns(columns)
        for formula_col in ordered_formula_columns:
            target_field = formula_col["target_field"]
            formula = formula_col["formula"]
            func_name = formula.get("function")
            func = FormulaRegistry.FUNCTIONS.get(func_name)
            if func is None:
                raise ValueError(f"Unknown formula function '{func_name}'")

            args = formula.get("args", [])
            kwargs = formula.get("kwargs", {})
            out_values = []
            for idx, row in output_df.iterrows():
                resolved_args: List[Any] = []
                for arg in args:
                    if isinstance(arg, str) and arg.startswith("$"):
                        resolved_args.append(row.get(arg[1:]))
                    else:
                        resolved_args.append(arg)
                out_values.append(func(resolved_args, kwargs))
            output_df[target_field] = out_values

        # Enforce required fields from template and per-column flags.
        required_per_column = {
            c["target_field"] for c in columns if c.get("required", False)
        }
        all_required = required_fields.union(required_per_column)

        for field in all_required:
            if field not in output_df.columns:
                issues.append(
                    cls._issue(
                        "missing_required_field",
                        -1,
                        field,
                        "Required field is missing from output",
                    )
                )
                continue
            for idx, value in output_df[field].items():
                if cls._empty(value):
                    issues.append(
                        cls._issue(
                            "missing_required_field",
                            int(idx),
                            field,
                            "Required field has no value",
                        )
                    )

        # Duplicate validation by dedup key.
        if dedup_keys:
            available_keys = [k for k in dedup_keys if k in output_df.columns]
            if available_keys:
                duplicate_mask = output_df.duplicated(subset=available_keys, keep=False)
                for idx in output_df[duplicate_mask].index.tolist():
                    issues.append(
                        cls._issue(
                            "duplicate_record",
                            int(idx),
                            ",".join(available_keys),
                            f"Duplicate record by keys: {available_keys}",
                        )
                    )

        # Respect display/output order by declared column order.
        declared_order = [c["target_field"] for c in columns]
        ordered_columns = [c for c in declared_order if c in output_df.columns]
        output_df = output_df[ordered_columns]

        return PipelineResult(dataframe=output_df, issues=issues)

    @classmethod
    def revalidate(cls, output_df: pd.DataFrame, definition: Dict[str, Any]) -> List[Dict[str, Any]]:
        """Re-run validation checks on corrected output (mapping/formulas already applied)."""
        columns: List[Dict[str, Any]] = definition.get("columns", [])
        required_fields = set(definition.get("required_fields", []))
        dedup_keys = definition.get("dedup_keys", [])

        issues: List[Dict[str, Any]] = []

        required_per_column = {c["target_field"] for c in columns if c.get("required", False)}
        all_required = required_fields.union(required_per_column)

        for field in all_required:
            if field not in output_df.columns:
                issues.append(
                    cls._issue("missing_required_field", -1, field, "Required field is missing from output")
                )
                continue
            for idx, value in output_df[field].items():
                if cls._empty(value):
                    issues.append(
                        cls._issue("missing_required_field", int(idx), field, "Required field has no value")
                    )

        if dedup_keys:
            available_keys = [k for k in dedup_keys if k in output_df.columns]
            if available_keys:
                duplicate_mask = output_df.duplicated(subset=available_keys, keep=False)
                for idx in output_df[duplicate_mask].index.tolist():
                    issues.append(
                        cls._issue(
                            "duplicate_record",
                            int(idx),
                            ",".join(available_keys),
                            f"Duplicate record by keys: {available_keys}",
                        )
                    )

        return issues
