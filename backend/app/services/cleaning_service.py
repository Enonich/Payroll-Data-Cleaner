"""
Data cleaning service - provides data cleaning and transformation functions
Extracted and generalized from the payroll data cleaning notebooks
"""
import re
from typing import Dict, List, Optional, Tuple, Any
import pandas as pd
import numpy as np
from datetime import date


class DataCleaningService:
    """Service for data cleaning operations"""
    
    @staticmethod
    def strip_column_names(df: pd.DataFrame) -> pd.DataFrame:
        """Remove leading/trailing whitespace from column names"""
        df = df.copy()
        df.columns = df.columns.str.strip()
        return df
    
    @staticmethod
    def normalize_staff_id(value: Any) -> str:
        """
        Normalize staff ID values:
        - Convert to string
        - Strip whitespace
        - Remove .0 suffix (from float conversion)
        """
        if pd.isna(value):
            return ''
        value_str = str(value).strip()
        # Remove .0 suffix that comes from float conversion
        if value_str.endswith('.0'):
            value_str = value_str[:-2]
        return value_str
    
    @staticmethod
    def normalize_staff_ids_column(df: pd.DataFrame, column: str) -> pd.DataFrame:
        """Normalize all staff IDs in a column"""
        df = df.copy()
        df[column] = df[column].apply(DataCleaningService.normalize_staff_id)
        return df
    
    @staticmethod
    def clean_currency_value(value: Any) -> float:
        """
        Clean currency/numeric values:
        - Handle NaN/None
        - Remove commas
        - Handle '-' as zero
        - Convert to float
        """
        if pd.isna(value):
            return 0.0
        if isinstance(value, (int, float)):
            return float(value)
        
        value_str = str(value).strip()
        if value_str == '-' or value_str == '' or value_str == ' -   ':
            return 0.0
        
        # Remove commas, quotes, currency symbols
        value_str = value_str.replace(',', '').replace('"', '').replace('GH₵', '').replace('GHȼ', '')
        
        try:
            return float(value_str)
        except ValueError:
            return 0.0
    
    @staticmethod
    def clean_currency_column(df: pd.DataFrame, column: str) -> pd.DataFrame:
        """Clean all currency values in a column"""
        df = df.copy()
        df[column] = df[column].apply(DataCleaningService.clean_currency_value)
        return df
    
    @staticmethod
    def normalize_grade(grade: Any) -> str:
        """
        Normalize grade/rank names:
        - Convert to uppercase
        - Remove extra whitespace
        - Remove periods
        - Handle Roman numeral conversions
        - Handle common concatenated patterns
        """
        if pd.isna(grade):
            return ''
        
        grade = ' '.join(str(grade).strip().upper().split())
        
        # Remove periods (e.g., "PRIN." -> "PRIN")
        grade = grade.replace('.', '')
        
        # Replace specific concatenated patterns
        grade = grade.replace('GDI', 'GD I').replace('GDII', 'GD II')
        grade = grade.replace('CLI', 'CL I').replace('CLII', 'CL II')
        
        # Convert standalone digit suffix to Roman numerals
        grade = re.sub(r'\b11\b(?=\s|$)', 'II', grade)
        grade = re.sub(r'\b1\b(?=\s|$)', 'I', grade)
        grade = re.sub(r'\b2\b(?=\s|$)', 'II', grade)
        grade = re.sub(r'\b3\b(?=\s|$)', 'III', grade)
        
        # Normalize multiple spaces
        grade = ' '.join(grade.split())
        
        return grade
    
    @staticmethod
    def normalize_grades_column(df: pd.DataFrame, column: str) -> pd.DataFrame:
        """Normalize all grades in a column"""
        df = df.copy()
        df[column] = df[column].apply(DataCleaningService.normalize_grade)
        return df
    
    @staticmethod
    def fix_branch_names(df: pd.DataFrame, column: str, 
                         corrections: Optional[Dict[str, str]] = None) -> pd.DataFrame:
        """
        Fix common branch name typos
        """
        df = df.copy()
        df[column] = df[column].str.strip()
        
        # Default corrections based on the notebooks
        if corrections is None:
            corrections = {
                'ABOFOUR': 'ABOFFOUR',
                'NKENKAASU': 'NKENKANSU'
            }
        
        df[column] = df[column].replace(corrections)
        return df
    
    @staticmethod
    def filter_numeric_ids(df: pd.DataFrame, column: str) -> pd.DataFrame:
        """
        Filter out rows with non-numeric IDs (like 'Grand Total')
        """
        def is_numeric_id(value):
            if pd.isna(value):
                return False
            try:
                int(value)
                return True
            except (ValueError, TypeError):
                return False
        
        df = df.copy()
        mask = df[column].apply(is_numeric_id)
        return df[mask].copy()
    
    @staticmethod
    def normalize_id_for_matching(id_value: Any, keep_digits: int = 5) -> int:
        """
        Normalize IDs for matching between files with different ID formats
        (e.g., 166xxxx vs 116xxxx)
        """
        try:
            id_int = int(id_value)
            return id_int % (10 ** keep_digits)
        except (ValueError, TypeError):
            return 0
    
    @staticmethod
    def add_normalized_id_column(df: pd.DataFrame, source_column: str, 
                                  new_column: str = 'ID_normalized',
                                  keep_digits: int = 5) -> pd.DataFrame:
        """Add a normalized ID column for matching"""
        df = df.copy()
        df[new_column] = df[source_column].apply(
            lambda x: DataCleaningService.normalize_id_for_matching(x, keep_digits)
        )
        return df
    
    @staticmethod
    def clean_dataframe(df: pd.DataFrame, 
                        strip_columns: bool = True,
                        staff_id_column: Optional[str] = None,
                        currency_columns: Optional[List[str]] = None,
                        grade_column: Optional[str] = None,
                        branch_column: Optional[str] = None) -> Tuple[pd.DataFrame, Dict[str, int]]:
        """
        Apply multiple cleaning operations to a DataFrame
        Returns the cleaned DataFrame and a summary of changes
        """
        changes = {}
        
        if strip_columns:
            df = DataCleaningService.strip_column_names(df)
            changes['columns_stripped'] = len(df.columns)
        
        if staff_id_column and staff_id_column in df.columns:
            original = df[staff_id_column].copy()
            df = DataCleaningService.normalize_staff_ids_column(df, staff_id_column)
            changes['staff_ids_normalized'] = (original != df[staff_id_column]).sum()
        
        if currency_columns:
            for col in currency_columns:
                if col in df.columns:
                    original = df[col].copy()
                    df = DataCleaningService.clean_currency_column(df, col)
                    changes[f'{col}_cleaned'] = (original.astype(str) != df[col].astype(str)).sum()
        
        if grade_column and grade_column in df.columns:
            original = df[grade_column].copy()
            df = DataCleaningService.normalize_grades_column(df, grade_column)
            changes['grades_normalized'] = (original != df[grade_column]).sum()
        
        if branch_column and branch_column in df.columns:
            original = df[branch_column].copy()
            df = DataCleaningService.fix_branch_names(df, branch_column)
            changes['branches_fixed'] = (original != df[branch_column]).sum()
        
        return df, changes
    
    @staticmethod
    def strip_whitespace_values_column(df: pd.DataFrame, column: str) -> pd.DataFrame:
        """Strip leading/trailing whitespace from string values in a column"""
        df = df.copy()
        if df[column].dtype == object:
            df[column] = df[column].str.strip()
        return df

    @staticmethod
    def uppercase_column(df: pd.DataFrame, column: str) -> pd.DataFrame:
        """Convert column values to uppercase"""
        df = df.copy()
        if df[column].dtype == object:
            df[column] = df[column].str.upper()
        return df

    @staticmethod
    def lowercase_column(df: pd.DataFrame, column: str) -> pd.DataFrame:
        """Convert column values to lowercase"""
        df = df.copy()
        if df[column].dtype == object:
            df[column] = df[column].str.lower()
        return df

    @staticmethod
    def titlecase_column(df: pd.DataFrame, column: str) -> pd.DataFrame:
        """Convert column values to title case"""
        df = df.copy()
        if df[column].dtype == object:
            df[column] = df[column].str.title()
        return df

    @staticmethod
    def remove_nulls_column(df: pd.DataFrame, column: str) -> pd.DataFrame:
        """Remove rows where the given column is null/empty"""
        df = df.copy()
        df = df[df[column].notna() & (df[column].astype(str).str.strip() != '')]
        return df.reset_index(drop=True)

    @staticmethod
    def apply_operation(df: pd.DataFrame, column: str, operation: str,
                        params: Optional[Dict] = None) -> Tuple[pd.DataFrame, int]:
        """
        Apply a named operation to a column.
        Returns (updated_df, number_of_changed_values).
        """
        if column not in df.columns:
            raise ValueError(f"Column '{column}' not found in dataframe")

        params = params or {}
        before = df[column].copy()

        op_map = {
            'normalize_staff_id': lambda d: DataCleaningService.normalize_staff_ids_column(d, column),
            'clean_currency':      lambda d: DataCleaningService.clean_currency_column(d, column),
            'normalize_grade':     lambda d: DataCleaningService.normalize_grades_column(d, column),
            'fix_branch':          lambda d: DataCleaningService.fix_branch_names(
                                        d, column, params.get('corrections')),
            'strip_whitespace':    lambda d: DataCleaningService.strip_whitespace_values_column(d, column),
            'uppercase':           lambda d: DataCleaningService.uppercase_column(d, column),
            'lowercase':           lambda d: DataCleaningService.lowercase_column(d, column),
            'titlecase':           lambda d: DataCleaningService.titlecase_column(d, column),
            'remove_nulls':        lambda d: DataCleaningService.remove_nulls_column(d, column),
        }

        if operation not in op_map:
            raise ValueError(f"Unknown operation '{operation}'. "
                             f"Valid operations: {', '.join(op_map.keys())}")

        df = op_map[operation](df)
        # For remove_nulls the row count changes, so compare on shared index
        shared_idx = before.index.intersection(df[column].index)
        changes = int((before.loc[shared_idx].astype(str) != df[column].loc[shared_idx].astype(str)).sum())
        if operation == 'remove_nulls':
            changes = int(len(before) - len(df))
        return df, changes

    @staticmethod
    def detect_column_types(df: pd.DataFrame) -> Dict[str, str]:
        """
        Detect likely column types based on column names and data
        """
        type_hints = {}
        
        for col in df.columns:
            col_lower = col.lower().strip()
            
            # Staff ID detection
            if any(x in col_lower for x in ['staff_id', 'staffid', 'staff id', 'employee id', 'emp_id']):
                type_hints[col] = 'staff_id'
            
            # Currency/money detection
            elif any(x in col_lower for x in ['salary', 'basic', 'allowance', 'deduction', 
                                               'gross', 'net', 'take home', 'takehome', 'pay']):
                type_hints[col] = 'currency'
            
            # Grade detection
            elif any(x in col_lower for x in ['grade', 'rank', 'level', 'step']):
                type_hints[col] = 'grade'
            
            # Branch detection
            elif any(x in col_lower for x in ['branch', 'location', 'office']):
                type_hints[col] = 'branch'
            
            # Name detection
            elif any(x in col_lower for x in ['name', 'fullname', 'full name']):
                type_hints[col] = 'name'
            
            else:
                type_hints[col] = 'unknown'
        
        return type_hints

    @staticmethod
    def parse_date(value: Any) -> Optional[date]:
        """
        Parse date values from common payroll formats, including Excel serial dates.
        """
        if value is None or (isinstance(value, float) and np.isnan(value)):
            return None

        # Excel serial date support.
        if isinstance(value, (int, float)):
            if value <= 0:
                return None
            try:
                return pd.to_datetime(value, unit='D', origin='1899-12-30').date()
            except Exception:
                return None

        value_str = str(value).strip()
        if not value_str:
            return None

        for dayfirst in (True, False):
            try:
                parsed = pd.to_datetime(value_str, dayfirst=dayfirst, errors='raise')
                return parsed.date()
            except Exception:
                continue
        return None

    @staticmethod
    def normalize_date_value(value: Any, output_format: str = "%Y-%m-%d") -> Optional[str]:
        parsed = DataCleaningService.parse_date(value)
        if parsed is None:
            return None
        return parsed.strftime(output_format)

    @staticmethod
    def normalize_name_value(value: Any) -> str:
        """
        Normalize names by trimming, title-casing, and handling Last, First format.
        """
        if value is None or (isinstance(value, float) and np.isnan(value)):
            return ''
        text = ' '.join(str(value).strip().split())
        if ',' in text:
            parts = [p.strip() for p in text.split(',', 1)]
            if len(parts) == 2 and parts[0] and parts[1]:
                text = f"{parts[1]} {parts[0]}"
        return text.title()

    @staticmethod
    def pad_id_value(value: Any, width: int) -> str:
        if value is None or (isinstance(value, float) and np.isnan(value)):
            return ''
        cleaned = DataCleaningService.normalize_staff_id(value)
        if width <= 0:
            return cleaned
        return cleaned.zfill(width)

    @staticmethod
    def normalize_id_prefix(value: Any, from_prefix: str, to_prefix: str) -> str:
        cleaned = DataCleaningService.normalize_staff_id(value)
        if from_prefix and cleaned.startswith(from_prefix):
            return f"{to_prefix}{cleaned[len(from_prefix):]}"
        return cleaned

    @staticmethod
    def coerce_numeric_value(value: Any) -> Optional[float]:
        if value is None or (isinstance(value, float) and np.isnan(value)):
            return None
        if isinstance(value, (int, float)):
            return float(value)
        cleaned = str(value).strip().replace(',', '')
        if cleaned == '':
            return None
        try:
            return float(cleaned)
        except ValueError:
            return None
