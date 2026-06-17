"""
Pydantic models for template-based import pipeline.
"""
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class TransformRule(BaseModel):
    name: str
    params: Dict[str, Any] = {}


class FormulaDefinition(BaseModel):
    function: str
    args: List[Any] = []
    kwargs: Dict[str, Any] = {}


class ColumnRule(BaseModel):
    target_field: str
    source_aliases: List[str] = []
    transforms: List[TransformRule] = []
    value_map: Dict[str, Any] = {}
    strict_value_map: bool = False
    required: bool = False
    formula: Optional[FormulaDefinition] = None


class TemplateDefinition(BaseModel):
    output_format: str = "csv"
    required_fields: List[str] = []
    dedup_keys: List[str] = []
    columns: List[ColumnRule]
