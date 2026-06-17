"""
Pydantic models for request/response schemas
"""
from pydantic import BaseModel
from typing import List, Dict, Any, Optional
from datetime import datetime
from enum import Enum


class FileInfo(BaseModel):
    """Information about an uploaded file"""
    id: str
    filename: str
    file_type: str
    size: int
    columns: List[str]
    row_count: int
    uploaded_at: datetime


class DataPreview(BaseModel):
    """Preview of file data"""
    columns: List[str]
    data: List[Dict[str, Any]]
    total_rows: int
    preview_rows: int


class CleaningOptions(BaseModel):
    """Options for data cleaning operations"""
    file_id: str
    strip_whitespace: bool = True
    normalize_staff_ids: bool = True
    clean_currency_values: bool = True
    columns_to_clean: Optional[List[str]] = None


class CleaningResult(BaseModel):
    """Result of a cleaning operation"""
    original_rows: int
    cleaned_rows: int
    changes_made: Dict[str, int]
    preview: DataPreview


class ComparisonRequest(BaseModel):
    """Request for comparing two files"""
    file1_id: str
    file2_id: str
    id_column_file1: str
    id_column_file2: str
    compare_columns: List[Dict[str, str]]  # [{"file1": "Basic", "file2": "Basic Salary"}]
    normalize_ids: bool = True


class ComparisonResult(BaseModel):
    """Result of a comparison operation"""
    total_file1: int
    total_file2: int
    matched: int
    only_in_file1: int
    only_in_file2: int
    with_differences: int
    without_differences: int
    summary: Dict[str, Any]


class AllowanceDeductionRequest(BaseModel):
    """Request for generating allowance/deduction files"""
    file_id: str
    staff_id_column: str
    value_columns: List[str]
    template_type: str  # 'allowance' or 'deduction'
    output_format: str = 'csv'


class ExportRequest(BaseModel):
    """Request for exporting data"""
    file_id: str
    format: str = 'csv'  # 'csv' or 'xlsx'
    filename: Optional[str] = None


class GradeNormalizationRequest(BaseModel):
    """Request for normalizing grades"""
    file_id: str
    grade_column: str
    salary_column: str
    salary_scale_file_id: str


class JobStatus(str, Enum):
    pending = "pending"
    processing = "processing"
    needs_review = "needs_review"
    completed = "completed"
    failed = "failed"


class RuleType(str, Enum):
    trim = "trim"
    title_case = "title_case"
    upper = "upper"
    lower = "lower"
    name_invert = "name_invert"
    date_normalize = "date_normalize"
    id_pad = "id_pad"
    id_prefix = "id_prefix"
    numeric = "numeric"


class ValidationIssueType(str, Enum):
    missing_required = "missing_required"
    duplicate_record = "duplicate_record"
    unmapped_value = "unmapped_value"
    invalid_format = "invalid_format"
    missing_source_column = "missing_source_column"


class FieldRule(BaseModel):
    type: RuleType
    options: Dict[str, Any] = {}


class FormulaDefinition(BaseModel):
    function: str
    args: List[str] = []
    options: Dict[str, Any] = {}


class ColumnRule(BaseModel):
    target_field: str
    source_aliases: List[str] = []
    rules: List[FieldRule] = []
    value_map: Dict[str, Any] = {}
    required: bool = False
    dedup_key: bool = False
    data_type: Optional[str] = None
    formula: Optional[FormulaDefinition] = None


class TemplateBase(BaseModel):
    name: str
    template_type: str
    target_system: str
    output_format: str = "csv"
    output_date_format: str = "%Y-%m-%d"
    columns: List[ColumnRule]


class TemplateCreate(TemplateBase):
    pass


class TemplateUpdate(BaseModel):
    name: Optional[str] = None
    template_type: Optional[str] = None
    target_system: Optional[str] = None
    output_format: Optional[str] = None
    output_date_format: Optional[str] = None
    columns: Optional[List[ColumnRule]] = None


class TemplateSummary(BaseModel):
    id: str
    name: str
    template_type: str
    target_system: str
    updated_at: datetime


class TemplateResponse(TemplateBase):
    id: str
    created_at: datetime
    updated_at: datetime


class TemplateInferenceRequest(BaseModel):
    file_id: str
    target_fields: List[str]
    template_name: Optional[str] = None
    template_type: Optional[str] = None
    target_system: Optional[str] = None


class InferredMapping(BaseModel):
    source_column: str
    suggested_target_field: Optional[str] = None
    confidence: float = 0.0


class TemplateInferenceResponse(BaseModel):
    file_id: str
    columns: List[str]
    sample_rows: List[Dict[str, Any]]
    suggestions: List[InferredMapping]


class ValidationIssue(BaseModel):
    row_index: Optional[int] = None
    field: Optional[str] = None
    issue_type: ValidationIssueType
    message: str
    value: Optional[Any] = None


class ProcessJobRequest(BaseModel):
    file_id: str
    template_id: str


class JobFixRequest(BaseModel):
    corrections: List[Dict[str, Any]] = []
    accepted_issue_ids: List[int] = []


class CleaningJobResponse(BaseModel):
    id: str
    template_id: str
    source_filename: str
    status: JobStatus
    output_file_id: Optional[str] = None
    issues: List[ValidationIssue] = []
    created_at: datetime
    updated_at: datetime
