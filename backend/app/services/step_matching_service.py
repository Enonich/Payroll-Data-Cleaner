"""
Step matching service - matches employees to salary scale steps
Extracted from Step_match.ipynb (Odotobri)
"""
from typing import Dict, List, Optional, Tuple, Any
import pandas as pd
import numpy as np
from app.services.cleaning_service import DataCleaningService


class StepMatchingService:
    """Service for matching employee grades and salaries to salary scale steps"""
    
    @staticmethod
    def prepare_salary_scale(salary_scale_df: pd.DataFrame,
                              grade_column: str = None) -> pd.DataFrame:
        """
        Prepare salary scale data for matching
        Converts wide format to long format if needed
        
        Args:
            salary_scale_df: DataFrame with salary scale data
            grade_column: Column containing grade names (if None, uses first column)
        
        Returns:
            Long-format DataFrame with columns: GRADE/RANK, Step, Annual
        """
        df = salary_scale_df.copy()
        
        if grade_column is None:
            grade_column = df.columns[0]
        
        # Convert to long format (melt)
        sal_long = df.melt(
            id_vars=[grade_column],
            var_name='Step',
            value_name='Annual'
        )
        sal_long.rename(columns={grade_column: 'GRADE/RANK'}, inplace=True)
        
        # Handle ranks separated by "/" - expand them into separate rows
        expanded_rows = []
        for idx, row in sal_long.iterrows():
            ranks = [r.strip() for r in str(row['GRADE/RANK']).split('/')]
            for rank in ranks:
                expanded_rows.append({
                    'GRADE/RANK': DataCleaningService.normalize_grade(rank),
                    'Step': row['Step'],
                    'Annual': row['Annual']
                })
        
        sal_long = pd.DataFrame(expanded_rows)
        
        # Remove rows with missing or non-numeric salary values
        sal_long = sal_long[pd.to_numeric(sal_long['Annual'], errors='coerce').notnull()]
        sal_long['Annual'] = sal_long['Annual'].astype(float).round(2)
        
        return sal_long
    
    @staticmethod
    def find_step_for_employee(emp_salary: float, emp_grade: str,
                                salary_scale: pd.DataFrame) -> Optional[str]:
        """
        Find the correct step for an employee based on salary and grade
        
        Args:
            emp_salary: Employee's annual salary
            emp_grade: Employee's normalized grade
            salary_scale: Prepared salary scale DataFrame
        
        Returns:
            Step name or None if no match found
        """
        # Split the employee grade/rank by "/" to handle combined roles
        roles = [r.strip() for r in emp_grade.split('/')]
        
        best_match = None
        best_salary_diff = float('inf')
        
        # Try to match each role
        for role in roles:
            matches = salary_scale[salary_scale['GRADE/RANK'] == role]
            if not matches.empty:
                # Find the step where the annual salary matches exactly
                step_row = matches[matches['Annual'] == emp_salary]
                if not step_row.empty:
                    return step_row.iloc[0]['Step']
                
                # If no exact match, find closest step by absolute difference
                closest_idx = (matches['Annual'] - emp_salary).abs().idxmin()
                salary_diff = abs(matches.loc[closest_idx, 'Annual'] - emp_salary)
                
                # Keep track of the best match across all roles
                if salary_diff < best_salary_diff:
                    best_salary_diff = salary_diff
                    best_match = matches.loc[closest_idx, 'Step']
        
        return best_match
    
    @staticmethod
    def match_employees_to_steps(employees_df: pd.DataFrame,
                                  salary_scale_df: pd.DataFrame,
                                  grade_column: str,
                                  salary_column: str,
                                  scale_grade_column: str = None) -> Tuple[pd.DataFrame, Dict[str, Any]]:
        """
        Match all employees to their salary steps
        
        Args:
            employees_df: DataFrame with employee data
            salary_scale_df: DataFrame with salary scale data
            grade_column: Column in employees_df containing grade/rank
            salary_column: Column in employees_df containing annual salary
            scale_grade_column: Column in salary_scale_df containing grade (or None for first column)
        
        Returns:
            Tuple of (processed_df_with_steps, match_statistics)
        """
        # Prepare data
        emp_df = employees_df.copy()
        
        # Normalize grades in employee data
        emp_df[grade_column] = emp_df[grade_column].apply(DataCleaningService.normalize_grade)
        
        # Clean and round salary values
        emp_df[salary_column] = emp_df[salary_column].apply(
            DataCleaningService.clean_currency_value
        ).round(2)
        
        # Prepare salary scale
        salary_scale = StepMatchingService.prepare_salary_scale(
            salary_scale_df, scale_grade_column
        )
        
        # Match employees to steps
        def find_step(row):
            return StepMatchingService.find_step_for_employee(
                row[salary_column],
                row[grade_column],
                salary_scale
            )
        
        emp_df['Step'] = emp_df.apply(find_step, axis=1)
        
        # Calculate statistics
        total = len(emp_df)
        matched = emp_df['Step'].notna().sum()
        unmatched = emp_df['Step'].isna().sum()
        
        # Find unmatched grades
        employee_grades = set(emp_df[grade_column].unique())
        salary_grades = set(salary_scale['GRADE/RANK'].unique())
        unmatched_grades = employee_grades - salary_grades
        
        stats = {
            'total_employees': total,
            'matched': matched,
            'unmatched': unmatched,
            'match_percentage': round(matched / total * 100, 1) if total > 0 else 0,
            'unmatched_grades': list(unmatched_grades),
            'grade_coverage': {
                'employee_grades': len(employee_grades),
                'salary_scale_grades': len(salary_grades),
                'matched_grades': len(employee_grades & salary_grades)
            }
        }
        
        return emp_df, stats
    
    @staticmethod
    def analyze_unmatched_employees(df: pd.DataFrame,
                                     grade_column: str,
                                     step_column: str = 'Step') -> pd.DataFrame:
        """
        Analyze employees who couldn't be matched to a step
        
        Returns:
            DataFrame with unmatched employees and their grades
        """
        unmatched = df[df[step_column].isna()].copy()
        
        # Group by grade to see patterns
        grade_counts = unmatched[grade_column].value_counts().reset_index()
        grade_counts.columns = ['Grade', 'Count']
        
        return grade_counts
    
    @staticmethod
    def validate_salary_scale(salary_scale_df: pd.DataFrame) -> Dict[str, Any]:
        """
        Validate a salary scale file structure
        
        Returns:
            Dictionary with validation results
        """
        issues = []
        
        if len(salary_scale_df.columns) < 2:
            issues.append("Salary scale should have at least 2 columns (Grade + Steps)")
        
        # Check for numeric values in step columns
        grade_col = salary_scale_df.columns[0]
        for col in salary_scale_df.columns[1:]:
            non_numeric = salary_scale_df[col].apply(
                lambda x: not pd.isna(x) and not isinstance(x, (int, float))
            ).sum()
            if non_numeric > 0:
                issues.append(f"Column '{col}' has {non_numeric} non-numeric values")
        
        # Check for empty grades
        empty_grades = salary_scale_df[grade_col].isna().sum()
        if empty_grades > 0:
            issues.append(f"Found {empty_grades} rows with empty grade names")
        
        return {
            'is_valid': len(issues) == 0,
            'issues': issues,
            'grades_count': salary_scale_df[grade_col].nunique(),
            'steps_count': len(salary_scale_df.columns) - 1
        }
