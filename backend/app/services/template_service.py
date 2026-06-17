"""
Template generation service - generates allowance and deduction files
Extracted from allow_and_deduc.ipynb
"""
import os
from typing import Dict, List, Optional, Any
from pathlib import Path
import pandas as pd
from app.services.cleaning_service import DataCleaningService


class TemplateService:
    """Service for generating allowance and deduction files from templates"""
    
    # Default allowance template structure
    DEFAULT_ALLOWANCE_TEMPLATE = {
        'staff_ID': '',
        '': '',  # Empty column
        'Taxable(Yes/No)': 'Yes',
        'Amount sysmbol(%/GHS)': 'GHS',
        'Rate/Amount': 0,
        'Duration Symbol(Month/Year)': 'Month',
        'Duration Period': 10000,
        'Of Type': 'Basic',
        'Allowance Limit': '',
        'Cash type': 'Cash'
    }
    
    # Default deduction template structure
    DEFAULT_DEDUCTION_TEMPLATE = {
        'StaffId(Do not Edit This Column)/ Account NO': '',
        'Staff Name': '',
        'Symbol(percentage(%)/currency(GHS))': 'GHS',
        'Amount/rate': 0
    }
    
    @staticmethod
    def generate_allowance_files(df: pd.DataFrame,
                                  staff_id_column: str,
                                  value_columns: List[str],
                                  template: Optional[Dict[str, Any]] = None) -> Dict[str, pd.DataFrame]:
        """
        Generate individual allowance files for each allowance type
        
        Args:
            df: Source DataFrame with employee data
            staff_id_column: Column containing staff IDs
            value_columns: List of columns containing allowance values
            template: Optional custom template dictionary
        
        Returns:
            Dictionary mapping allowance names to DataFrames
        """
        if template is None:
            template = TemplateService.DEFAULT_ALLOWANCE_TEMPLATE.copy()
        
        # Clean column names
        df = df.copy()
        df.columns = df.columns.str.strip()
        
        results = {}
        
        for col in value_columns:
            if col not in df.columns:
                continue
            
            # Filter non-zero and non-null values
            col_data = df[[staff_id_column, col]].copy()
            col_data[col] = col_data[col].apply(DataCleaningService.clean_currency_value)
            valid_rows = col_data[(col_data[col].notna()) & (col_data[col] != 0)].copy()
            
            if valid_rows.empty:
                continue
            
            # Create new DataFrame with template structure
            new_df = pd.DataFrame(columns=template.keys())
            
            for idx, row in valid_rows.iterrows():
                new_row = template.copy()
                new_row['staff_ID'] = row[staff_id_column]
                new_row['Rate/Amount'] = row[col]
                new_df = pd.concat([new_df, pd.DataFrame([new_row])], ignore_index=True)
            
            # Sanitize column name for file naming
            safe_name = "".join([c for c in col if c.isalnum() or c in (' ', '_', '-')]).strip()
            results[f"{safe_name}_allowance"] = new_df
        
        return results
    
    @staticmethod
    def generate_deduction_files(df: pd.DataFrame,
                                  staff_id_column: str,
                                  value_columns: List[str],
                                  exclude_columns: Optional[List[str]] = None,
                                  template: Optional[Dict[str, Any]] = None) -> Dict[str, pd.DataFrame]:
        """
        Generate individual deduction files for each deduction type
        
        Args:
            df: Source DataFrame with employee data
            staff_id_column: Column containing staff IDs
            value_columns: List of columns to process (or None for all)
            exclude_columns: Columns to exclude from processing
            template: Optional custom template dictionary
        
        Returns:
            Dictionary mapping deduction names to DataFrames
        """
        if template is None:
            template = TemplateService.DEFAULT_DEDUCTION_TEMPLATE.copy()
        
        if exclude_columns is None:
            exclude_columns = []
        
        # Clean column names
        df = df.copy()
        df.columns = df.columns.str.strip()
        
        # If value_columns not specified, use all columns except excluded
        if value_columns is None:
            value_columns = [c for c in df.columns if c not in exclude_columns and c != staff_id_column]
        
        results = {}
        
        for col in value_columns:
            if col not in df.columns or col in exclude_columns:
                continue
            
            # Clean the data for this column
            col_data = df[[staff_id_column, col]].copy()
            col_data['cleaned_value'] = col_data[col].apply(DataCleaningService.clean_currency_value)
            
            # Filter rows with valid deductions (non-zero)
            valid_rows = col_data[col_data['cleaned_value'] != 0].copy()
            
            if valid_rows.empty:
                continue
            
            # Create new DataFrame with template structure
            template_cols = list(template.keys())
            new_df = pd.DataFrame(columns=template_cols)
            
            for idx, row in valid_rows.iterrows():
                new_row = {
                    template_cols[0]: row[staff_id_column],  # StaffId
                    template_cols[1]: '',  # Staff Name (leave empty)
                    template_cols[2]: 'GHS',  # Symbol
                    template_cols[3]: row['cleaned_value']  # Amount
                }
                new_df = pd.concat([new_df, pd.DataFrame([new_row])], ignore_index=True)
            
            # Sanitize column name for file naming
            safe_name = "".join([c for c in col if c.isalnum() or c in (' ', '_', '-')]).strip()
            results[f"{safe_name}_deduction"] = new_df
        
        return results
    
    @staticmethod
    def generate_employee_import_template(df: pd.DataFrame,
                                           staff_id_column: str,
                                           name_column: Optional[str] = None) -> pd.DataFrame:
        """
        Generate employee import template from a DataFrame
        
        Args:
            df: Source DataFrame
            staff_id_column: Column containing staff IDs
            name_column: Optional column containing names
        
        Returns:
            DataFrame in employee import template format
        """
        import random
        
        def generate_ghana_phone():
            prefixes = ['024', '054', '055', '026', '027', '057', '020', '050', '059', '028', '056']
            prefix = random.choice(prefixes)
            number = ''.join(random.choices('0123456789', k=7))
            return prefix + number
        
        import_df = pd.DataFrame()
        import_df['StaffId'] = df[staff_id_column].apply(DataCleaningService.normalize_staff_id)
        
        if name_column and name_column in df.columns:
            import_df['Fullname'] = df[name_column]
        else:
            import_df['Fullname'] = ''  # Leave empty for manual filling
        
        import_df['Gender'] = ['Male' if i % 2 == 0 else 'Female' for i in range(len(import_df))]
        import_df['Phone'] = [generate_ghana_phone() for _ in range(len(import_df))]
        
        return import_df
    
    @staticmethod
    def identify_allowance_deduction_columns(df: pd.DataFrame,
                                              exclude_keywords: Optional[List[str]] = None) -> Dict[str, List[str]]:
        """
        Automatically identify potential allowance and deduction columns
        
        Returns:
            Dictionary with 'allowances', 'deductions', and 'other' lists
        """
        if exclude_keywords is None:
            exclude_keywords = ['staff_id', 'staffid', 'name', 'branch', 'rank', 
                               'level', 'basic', 'gross', 'taxable', 'relief']
        
        allowance_keywords = ['allowance', 'allow', 'transport', 'food', 'risk', 
                             'phone', 'utility', 'welfare', 'rent', 'maint']
        deduction_keywords = ['deduction', 'deduc', 'tax', 'ssnit', 'ssf', 'pf',
                             'union', 'loan', 'ded', 'tuc', 'olads']
        
        result = {
            'allowances': [],
            'deductions': [],
            'other': []
        }
        
        for col in df.columns:
            col_lower = col.lower().strip()
            
            # Skip excluded columns
            if any(kw in col_lower for kw in exclude_keywords):
                continue
            
            if any(kw in col_lower for kw in allowance_keywords):
                result['allowances'].append(col)
            elif any(kw in col_lower for kw in deduction_keywords):
                result['deductions'].append(col)
            else:
                result['other'].append(col)
        
        return result
