"""
Comparison service - handles payroll file comparisons
Extracted and generalized from the payroll comparison notebooks
"""
from typing import Dict, List, Optional, Tuple, Any
import pandas as pd
import numpy as np
from app.services.cleaning_service import DataCleaningService


class ComparisonService:
    """Service for comparing payroll data between files"""

    @staticmethod
    def _column_match_score(col1: str, col2: str) -> int:
        def tokens(value: str) -> set:
            normalized = ''.join(ch.lower() if ch.isalnum() else ' ' for ch in str(value))
            return {token for token in normalized.split() if token}

        tokens1 = tokens(col1)
        tokens2 = tokens(col2)
        joined1 = ''.join(tokens1)
        joined2 = ''.join(tokens2)
        score = 0

        if joined1 == joined2:
            score += 40
        if tokens1 & tokens2:
            score += 20 * len(tokens1 & tokens2)

        preferred_groups = [
            {'account', 'acct', 'accountno', 'accountnumber', 'number', 'no'},
            {'ssnit', 'ssf', 'social', 'security'},
            {'staff', 'employee', 'emp', 'id'},
            {'tin', 'tax'},
        ]
        for group in preferred_groups:
            if tokens1 & group and tokens2 & group:
                score += 30

        return score

    @classmethod
    def _valid_normalized_ids(cls, df: pd.DataFrame, column: str,
                              normalize_ids: bool, keep_digits: int) -> set:
        if df is None or column not in df.columns:
            return set()
        ids = set(cls._normalized_id_series(df[column], normalize_ids, keep_digits))
        ids.discard('')
        return ids

    @staticmethod
    def _keep_digits_for_pair(col1: str, col2: str, requested_keep_digits: int) -> int:
        joined = f"{col1} {col2}".lower()
        if any(token in joined for token in ("account", "acct", "ssnit", "ssf", "tin")):
            return 0
        return requested_keep_digits

    @classmethod
    def resolve_matching_columns(cls, df1: pd.DataFrame, df2: pd.DataFrame,
                                 requested_id_col1: str, requested_id_col2: str,
                                 normalize_ids: bool = True,
                                 keep_digits: int = 5) -> Dict[str, Any]:
        """
        Use the requested ID columns when they produce matches; otherwise pick the
        best overlapping identifier-like columns, such as Account Number or SSNIT.
        """
        requested_pair_keep_digits = cls._keep_digits_for_pair(
            requested_id_col1,
            requested_id_col2,
            keep_digits,
        )
        requested_ids1 = cls._valid_normalized_ids(df1, requested_id_col1, normalize_ids, requested_pair_keep_digits)
        requested_ids2 = cls._valid_normalized_ids(df2, requested_id_col2, normalize_ids, requested_pair_keep_digits)
        requested_overlap = len(requested_ids1 & requested_ids2)

        best = {
            'id_col1': requested_id_col1,
            'id_col2': requested_id_col2,
            'valid_ids_file1': len(requested_ids1),
            'valid_ids_file2': len(requested_ids2),
            'overlap': requested_overlap,
            'auto_selected': False,
            'requested_id_col1': requested_id_col1,
            'requested_id_col2': requested_id_col2,
            'keep_digits': requested_pair_keep_digits,
        }

        # Respect the user's ID column choice whenever it produces any overlap.
        if requested_overlap > 0:
            return best

        candidate_terms = ('id', 'staff', 'employee', 'emp', 'account', 'acct', 'ssnit', 'ssf', 'tin')
        cols1 = [c for c in df1.columns if any(term in str(c).lower() for term in candidate_terms)]
        cols2 = [c for c in df2.columns if any(term in str(c).lower() for term in candidate_terms)]

        for col1 in cols1:
            pair_keep_digits = cls._keep_digits_for_pair(col1, "", keep_digits)
            ids1 = cls._valid_normalized_ids(df1, col1, normalize_ids, pair_keep_digits)
            if not ids1:
                continue
            for col2 in cols2:
                pair_keep_digits = cls._keep_digits_for_pair(col1, col2, keep_digits)
                ids1 = cls._valid_normalized_ids(df1, col1, normalize_ids, pair_keep_digits)
                ids2 = cls._valid_normalized_ids(df2, col2, normalize_ids, pair_keep_digits)
                if not ids2:
                    continue
                overlap = len(ids1 & ids2)
                if overlap == 0:
                    continue
                score = (overlap * 1000) + cls._column_match_score(col1, col2)
                best_score = (best['overlap'] * 1000) + cls._column_match_score(best['id_col1'], best['id_col2'])
                if score > best_score:
                    best.update({
                        'id_col1': col1,
                        'id_col2': col2,
                        'valid_ids_file1': len(ids1),
                        'valid_ids_file2': len(ids2),
                        'overlap': overlap,
                        'auto_selected': col1 != requested_id_col1 or col2 != requested_id_col2,
                        'keep_digits': pair_keep_digits,
                    })

        return best

    @staticmethod
    def _normalize_matching_id(value: Any, normalize_ids: bool, keep_digits: int) -> str:
        cleaned = DataCleaningService.normalize_staff_id(value)
        if not cleaned:
            return ''

        if not normalize_ids:
            return cleaned

        digits = ''.join(ch for ch in cleaned if ch.isdigit())
        if not digits:
            return ''

        if keep_digits > 0:
            digits = digits[-keep_digits:]
        return digits

    @staticmethod
    def _json_safe_scalar(value: Any) -> Any:
        if pd.isna(value):
            return None
        if isinstance(value, np.generic):
            return value.item()
        return value

    @classmethod
    def _json_safe_dataframe(cls, df: pd.DataFrame) -> pd.DataFrame:
        if df is None or len(df) == 0:
            return df
        if hasattr(df, 'map'):
            safe_df = df.map(cls._json_safe_scalar)
        else:
            safe_df = df.applymap(cls._json_safe_scalar)
        return safe_df.astype(object).where(pd.notna(safe_df), None)

    @staticmethod
    def _sample_presence_rows(df: pd.DataFrame, id_col: str, name_col: Optional[str] = None,
                              limit: int = 12) -> List[Dict[str, Any]]:
        if df is None or len(df) == 0 or id_col not in df.columns:
            return []

        sample = []
        subset_cols = [id_col]
        if name_col and name_col in df.columns and name_col not in subset_cols:
            subset_cols.append(name_col)

        for _, row in df[subset_cols].head(limit).iterrows():
            item = {
                'employee_id': ComparisonService._json_safe_scalar(row.get(id_col)),
            }
            if name_col and name_col in subset_cols:
                item['employee_name'] = ComparisonService._json_safe_scalar(row.get(name_col))
            sample.append(item)
        return sample

    @staticmethod
    def _build_employee_data_analytics(mismatches_df: pd.DataFrame,
                                       matched: int,
                                       column_mappings: List[Dict[str, str]]) -> Dict[str, Any]:
        matched_count = int(matched)
        total_fields_compared = len(column_mappings)
        numeric_fields = [m for m in column_mappings if m.get('type') in ('currency', 'number', 'numeric')]
        text_fields = [m for m in column_mappings if m.get('type') not in ('currency', 'number', 'numeric')]

        if mismatches_df is None or len(mismatches_df) == 0:
            return {
                'matched_rate': 0 if matched_count == 0 else 1,
                'field_summary': [],
                'largest_variance_field': None,
                'total_abs_difference': 0,
                'numeric_fields_compared': len(numeric_fields),
                'text_fields_compared': len(text_fields),
                'total_fields_compared': total_fields_compared,
            }

        group = mismatches_df.groupby('field', dropna=False)
        field_summary = []
        for field, field_df in group:
            affected_employees = int(field_df['employee_id'].nunique()) if 'employee_id' in field_df.columns else len(field_df)
            mismatch_count = int(len(field_df))
            comparison_type = field_df['comparison_type'].iloc[0] if 'comparison_type' in field_df.columns else 'text'
            summary = {
                'field': field,
                'comparison_type': comparison_type,
                'mismatch_count': mismatch_count,
                'affected_employees': affected_employees,
                'employee_impact_rate': 0 if matched_count == 0 else affected_employees / matched_count,
            }
            if 'abs_difference' in field_df.columns:
                summary['total_abs_difference'] = float(field_df['abs_difference'].sum())
                summary['average_abs_difference'] = float(field_df['abs_difference'].mean())
                if 'difference' in field_df.columns:
                    summary['net_difference'] = float(field_df['difference'].sum())
            field_summary.append(summary)

        field_summary = sorted(
            field_summary,
            key=lambda item: (
                item.get('total_abs_difference', 0),
                item.get('mismatch_count', 0),
                item.get('affected_employees', 0),
            ),
            reverse=True,
        )

        largest_variance_field = next(
            (item for item in field_summary if item.get('total_abs_difference', 0) > 0),
            field_summary[0] if field_summary else None,
        )

        return {
            'matched_rate': 0 if matched_count == 0 else int(mismatches_df['employee_id'].nunique()) / matched_count,
            'field_summary': field_summary,
            'largest_variance_field': largest_variance_field,
            'total_abs_difference': float(mismatches_df['abs_difference'].sum()) if 'abs_difference' in mismatches_df.columns else 0,
            'numeric_fields_compared': len(numeric_fields),
            'text_fields_compared': len(text_fields),
            'total_fields_compared': total_fields_compared,
        }

    @staticmethod
    def _normalized_id_series(series: pd.Series, normalize_ids: bool, keep_digits: int) -> pd.Series:
        return series.apply(
            lambda x: ComparisonService._normalize_matching_id(x, normalize_ids, keep_digits)
        )

    @staticmethod
    def _normalize_comparison_value(value: Any, value_type: str) -> Any:
        if pd.isna(value):
            return ''

        if value_type in ('currency', 'number', 'numeric'):
            return DataCleaningService.clean_currency_value(value)

        if value_type == 'grade':
            return DataCleaningService.normalize_grade(value)

        if value_type == 'name':
            tokens = ComparisonService._name_tokens(value)
            return ' '.join(sorted(tokens))

        text = str(value).strip()
        if value_type == 'case_sensitive':
            return text
        return ' '.join(text.upper().split())

    @staticmethod
    def _name_tokens(value: Any) -> set:
        if pd.isna(value):
            return set()
        text = str(value).upper()
        cleaned = ''.join(ch if ch.isalnum() else ' ' for ch in text)
        ignored = {'MR', 'MRS', 'MS', 'DR', 'PROF'}
        return {token for token in cleaned.split() if token and token not in ignored}

    @staticmethod
    def _names_differ(value1: Any, value2: Any) -> bool:
        tokens1 = ComparisonService._name_tokens(value1)
        tokens2 = ComparisonService._name_tokens(value2)
        if not tokens1 and not tokens2:
            return False
        if not tokens1 or not tokens2:
            return True
        overlap = len(tokens1 & tokens2)
        similarity = overlap / max(len(tokens1), len(tokens2))
        return similarity < 0.65

    @staticmethod
    def _values_differ(value1: Any, value2: Any, value_type: str, tolerance: float) -> bool:
        if value_type == 'name':
            return ComparisonService._names_differ(value1, value2)

        normalized1 = ComparisonService._normalize_comparison_value(value1, value_type)
        normalized2 = ComparisonService._normalize_comparison_value(value2, value_type)

        if value_type in ('currency', 'number', 'numeric'):
            return abs(float(normalized2) - float(normalized1)) > tolerance

        return normalized1 != normalized2

    @staticmethod
    def compare_employee_data(df1: pd.DataFrame, df2: pd.DataFrame,
                              id_col1: str, id_col2: str,
                              column_mappings: List[Dict[str, str]],
                              name_col1: Optional[str] = None,
                              name_col2: Optional[str] = None,
                              normalize_ids: bool = True,
                              keep_digits: int = 5,
                              tolerance: float = 0.01) -> Dict[str, Any]:
        """
        Compare employee records across files and return field-level issues.
        column_mappings: [{"file1": "Grade", "file2": "Rank", "label": "Grade", "type": "grade"}]
        """
        df1_work = df1.copy()
        df2_work = df2.copy()
        merge_col = '_comparison_id'
        df1_work[merge_col] = ComparisonService._normalized_id_series(
            df1_work[id_col1], normalize_ids, keep_digits
        )
        df2_work[merge_col] = ComparisonService._normalized_id_series(
            df2_work[id_col2], normalize_ids, keep_digits
        )

        duplicate_ids_file1 = sorted(
            [x for x in df1_work[df1_work[merge_col].duplicated()][merge_col].unique().tolist() if x != '']
        )
        duplicate_ids_file2 = sorted(
            [x for x in df2_work[df2_work[merge_col].duplicated()][merge_col].unique().tolist() if x != '']
        )

        valid_ids1 = set(df1_work.loc[df1_work[merge_col] != '', merge_col])
        valid_ids2 = set(df2_work.loc[df2_work[merge_col] != '', merge_col])
        only_ids1 = valid_ids1 - valid_ids2
        only_ids2 = valid_ids2 - valid_ids1

        only_in_file1 = df1_work[df1_work[merge_col].isin(only_ids1)].copy()
        only_in_file2 = df2_work[df2_work[merge_col].isin(only_ids2)].copy()

        payload_cols1 = [merge_col, id_col1]
        payload_cols2 = [merge_col, id_col2]
        if name_col1 and name_col1 in df1_work.columns:
            payload_cols1.append(name_col1)
        if name_col2 and name_col2 in df2_work.columns:
            payload_cols2.append(name_col2)

        for mapping in column_mappings:
            col1 = mapping['file1']
            col2 = mapping['file2']
            if col1 not in payload_cols1:
                payload_cols1.append(col1)
            if col2 not in payload_cols2:
                payload_cols2.append(col2)

        merged = pd.merge(
            df1_work[df1_work[merge_col] != ''][payload_cols1],
            df2_work[df2_work[merge_col] != ''][payload_cols2],
            on=merge_col,
            how='inner',
            suffixes=('_file1', '_file2')
        )

        def merged_col_name(column: str, side: str) -> str:
            suffix = f'_{side}'
            suffixed = f'{column}{suffix}'
            return suffixed if suffixed in merged.columns else column

        mismatch_rows = []
        matched_without_differences = 0

        for _, row in merged.iterrows():
            employee_issue_count = 0
            for mapping in column_mappings:
                col1 = mapping['file1']
                col2 = mapping['file2']
                value_type = mapping.get('type', 'text')
                label = mapping.get('label') or mapping.get('field') or col1
                source_col = merged_col_name(col1, 'file1')
                target_col = merged_col_name(col2, 'file2')
                value1 = row[source_col]
                value2 = row[target_col]

                if ComparisonService._values_differ(value1, value2, value_type, tolerance):
                    employee_issue_count += 1
                    issue = {
                        'issue_type': 'field_mismatch',
                        'employee_id': row[merge_col],
                        'file1_id': row[merged_col_name(id_col1, 'file1')],
                        'file2_id': row[merged_col_name(id_col2, 'file2')],
                        'field': label,
                        'file1_column': col1,
                        'file2_column': col2,
                        'file1_value': value1,
                        'file2_value': value2,
                        'comparison_type': value_type,
                    }
                    if value_type in ('currency', 'number', 'numeric'):
                        clean1 = DataCleaningService.clean_currency_value(value1)
                        clean2 = DataCleaningService.clean_currency_value(value2)
                        issue['difference'] = clean2 - clean1
                        issue['abs_difference'] = abs(clean2 - clean1)
                    if name_col1 and merged_col_name(name_col1, 'file1') in merged.columns:
                        issue['file1_name'] = row[merged_col_name(name_col1, 'file1')]
                    if name_col2 and merged_col_name(name_col2, 'file2') in merged.columns:
                        issue['file2_name'] = row[merged_col_name(name_col2, 'file2')]
                    mismatch_rows.append({
                        key: ComparisonService._json_safe_scalar(value)
                        for key, value in issue.items()
                    })

            if employee_issue_count == 0:
                matched_without_differences += 1

        mismatches_df = pd.DataFrame(mismatch_rows)
        if len(mismatches_df) > 0:
            sort_cols = ['employee_id', 'field']
            if 'abs_difference' in mismatches_df.columns:
                sort_cols = ['abs_difference', 'employee_id', 'field']
                mismatches_df = mismatches_df.sort_values(sort_cols, ascending=[False, True, True])
            else:
                mismatches_df = mismatches_df.sort_values(sort_cols)

        issue_employee_count = (
            int(mismatches_df['employee_id'].nunique()) if len(mismatches_df) > 0 else 0
        )

        analytics = ComparisonService._build_employee_data_analytics(
            mismatches_df,
            len(merged),
            column_mappings,
        )

        only_in_file1_clean = ComparisonService._json_safe_dataframe(
            only_in_file1.drop(columns=[merge_col], errors='ignore')
        )
        only_in_file2_clean = ComparisonService._json_safe_dataframe(
            only_in_file2.drop(columns=[merge_col], errors='ignore')
        )
        mismatches_clean = ComparisonService._json_safe_dataframe(mismatches_df)

        return {
            'total_file1': len(df1),
            'total_file2': len(df2),
            'matched': len(merged),
            'only_in_file1': len(only_in_file1),
            'only_in_file2': len(only_in_file2),
            'employees_with_differences': issue_employee_count,
            'employees_without_differences': matched_without_differences,
            'field_differences': len(mismatches_df),
            'duplicate_ids_file1': len(duplicate_ids_file1),
            'duplicate_ids_file2': len(duplicate_ids_file2),
            'duplicate_id_samples_file1': duplicate_ids_file1[:20],
            'duplicate_id_samples_file2': duplicate_ids_file2[:20],
            'analytics': analytics,
            'mismatches_df': mismatches_clean,
            'only_in_file1_df': only_in_file1_clean,
            'only_in_file2_df': only_in_file2_clean,
            'only_in_file1_preview': ComparisonService._sample_presence_rows(
                only_in_file1_clean,
                id_col1,
                name_col1,
            ),
            'only_in_file2_preview': ComparisonService._sample_presence_rows(
                only_in_file2_clean,
                id_col2,
                name_col2,
            ),
        }

    @staticmethod
    def find_common_employees(df1: pd.DataFrame, df2: pd.DataFrame,
                               id_col1: str, id_col2: str,
                               normalize_ids: bool = True,
                               keep_digits: int = 5) -> Tuple[set, set, set]:
        """
        Find employees in both files, only in file 1, and only in file 2.
        Invalid or non-matchable IDs are excluded from the comparison key space.
        """
        ids1 = set(
            ComparisonService._normalized_id_series(df1[id_col1], normalize_ids, keep_digits)
        )
        ids2 = set(
            ComparisonService._normalized_id_series(df2[id_col2], normalize_ids, keep_digits)
        )
        ids1.discard('')
        ids2.discard('')

        common = ids1 & ids2
        only_in_df1 = ids1 - ids2
        only_in_df2 = ids2 - ids1

        return common, only_in_df1, only_in_df2
    
    @staticmethod
    def compare_salaries(df1: pd.DataFrame, df2: pd.DataFrame,
                          id_col1: str, id_col2: str,
                          salary_col1: str, salary_col2: str,
                          name_col1: Optional[str] = None,
                          name_col2: Optional[str] = None,
                          normalize_ids: bool = True,
                          keep_digits: int = 5,
                          tolerance: float = 0.01) -> Dict[str, Any]:
        """
        Compare salaries between two files
        Returns comprehensive comparison results
        """
        # Prepare copies and rename salary/id columns to fixed names so that
        # identical column names across the two files don't clash after the merge.
        df1_clean = df1.copy()
        df2_clean = df2.copy()

        # Stable internal column names – immune to same-name collisions
        SAL1 = '_salary_file1'
        SAL2 = '_salary_file2'
        ID1  = '_orig_id_file1'
        ID2  = '_orig_id_file2'
        NAME1 = '_name_file1'
        NAME2 = '_name_file2'

        # Clean currency columns using the stable names
        df1_clean[SAL1] = df1_clean[salary_col1].apply(DataCleaningService.clean_currency_value)
        df2_clean[SAL2] = df2_clean[salary_col2].apply(DataCleaningService.clean_currency_value)

        # Preserve original ID values under stable names
        df1_clean[ID1] = df1_clean[id_col1]
        df2_clean[ID2] = df2_clean[id_col2]

        # Add normalized ID columns for merging
        if normalize_ids:
            df1_clean['_id_normalized'] = ComparisonService._normalized_id_series(
                df1_clean[id_col1], normalize_ids, keep_digits
            )
            df2_clean['_id_normalized'] = ComparisonService._normalized_id_series(
                df2_clean[id_col2], normalize_ids, keep_digits
            )
            merge_col = '_id_normalized'
        else:
            df1_clean['_id_str'] = ComparisonService._normalized_id_series(
                df1_clean[id_col1], normalize_ids, keep_digits
            )
            df2_clean['_id_str'] = ComparisonService._normalized_id_series(
                df2_clean[id_col2], normalize_ids, keep_digits
            )
            merge_col = '_id_str'

        df1_clean = df1_clean[df1_clean[merge_col] != ''].copy()
        df2_clean = df2_clean[df2_clean[merge_col] != ''].copy()

        # Build column lists using the stable names only
        cols1 = [merge_col, ID1, SAL1]
        cols2 = [merge_col, ID2, SAL2]

        if name_col1 and name_col1 in df1_clean.columns:
            df1_clean[NAME1] = df1_clean[name_col1]
            cols1.append(NAME1)
        if name_col2 and name_col2 in df2_clean.columns:
            df2_clean[NAME2] = df2_clean[name_col2]
            cols2.append(NAME2)

        # Merge – no suffix collisions because all payload columns are uniquely named
        merged = pd.merge(
            df1_clean[cols1],
            df2_clean[cols2],
            on=merge_col,
            how='inner'
        )

        # Rename stable internal names to friendly display names
        rename_map = {
            ID1: f'{id_col1}_file1',
            ID2: f'{id_col2}_file2',
            SAL1: f'{salary_col1}_file1',
            SAL2: f'{salary_col2}_file2',
        }
        if name_col1:
            rename_map[NAME1] = f'{name_col1}_file1'
        if name_col2:
            rename_map[NAME2] = f'{name_col2}_file2'
        merged = merged.rename(columns=rename_map)

        sal1_col = f'{salary_col1}_file1'
        sal2_col = f'{salary_col2}_file2'

        # Calculate difference
        merged['Difference'] = merged[sal2_col] - merged[sal1_col]
        merged['Abs_Difference'] = merged['Difference'].abs()
        
        # Separate by difference
        no_diff = merged[merged['Abs_Difference'] < tolerance].copy()
        with_diff = merged[merged['Abs_Difference'] >= tolerance].copy()
        
        # Sort by absolute difference
        with_diff = with_diff.sort_values('Abs_Difference', ascending=False)
        
        # Find employees only in each file
        common, only1, only2 = ComparisonService.find_common_employees(
            df1, df2, id_col1, id_col2, normalize_ids, keep_digits
        )
        
        # Get dataframes for employees only in each file
        if normalize_ids:
            only_in_file1 = df1[df1[id_col1].apply(
                lambda x: DataCleaningService.normalize_id_for_matching(x, keep_digits)
            ).isin(only1)].copy()
            only_in_file2 = df2[df2[id_col2].apply(
                lambda x: DataCleaningService.normalize_id_for_matching(x, keep_digits)
            ).isin(only2)].copy()
        else:
            only_in_file1 = df1[df1[id_col1].apply(
                DataCleaningService.normalize_staff_id
            ).isin(only1)].copy()
            only_in_file2 = df2[df2[id_col2].apply(
                DataCleaningService.normalize_staff_id
            ).isin(only2)].copy()
        
        # Calculate statistics
        stats = {}
        if len(with_diff) > 0:
            stats = {
                'max_difference': float(with_diff['Difference'].max()),
                'min_difference': float(with_diff['Difference'].min()),
                'avg_difference': float(with_diff['Difference'].mean()),
                'total_difference': float(with_diff['Difference'].sum()),
                'positive_differences': int((with_diff['Difference'] > 0).sum()),
                'negative_differences': int((with_diff['Difference'] < 0).sum())
            }
        
        return {
            'total_file1': len(df1),
            'total_file2': len(df2),
            'matched': len(merged),
            'only_in_file1': len(only_in_file1),
            'only_in_file2': len(only_in_file2),
            'with_differences': len(with_diff),
            'without_differences': len(no_diff),
            'statistics': stats,
            'comparison_df': merged,
            'no_difference_df': no_diff,
            'with_difference_df': with_diff,
            'only_in_file1_df': only_in_file1,
            'only_in_file2_df': only_in_file2
        }
    
    @staticmethod
    def compare_multiple_columns(df1: pd.DataFrame, df2: pd.DataFrame,
                                  id_col1: str, id_col2: str,
                                  column_mappings: List[Dict[str, str]],
                                  normalize_ids: bool = True,
                                  keep_digits: int = 5) -> Dict[str, Any]:
        """
        Compare multiple columns between two files
        column_mappings: [{"file1": "Basic", "file2": "Basic Salary", "type": "currency"}, ...]
        """
        results = {}
        
        for mapping in column_mappings:
            col1 = mapping['file1']
            col2 = mapping['file2']
            col_type = mapping.get('type', 'currency')
            
            if col1 not in df1.columns or col2 not in df2.columns:
                results[col1] = {'error': f'Column not found in one of the files'}
                continue
            
            comparison = ComparisonService.compare_salaries(
                df1, df2, id_col1, id_col2, col1, col2,
                normalize_ids=normalize_ids, keep_digits=keep_digits
            )
            
            results[col1] = {
                'with_differences': comparison['with_differences'],
                'without_differences': comparison['without_differences'],
                'statistics': comparison['statistics']
            }
        
        return results
    
    @staticmethod
    def generate_comparison_report(comparison_result: Dict[str, Any]) -> str:
        """
        Generate a text report from comparison results
        """
        lines = []
        lines.append("=" * 70)
        lines.append("PAYROLL COMPARISON REPORT")
        lines.append("=" * 70)
        lines.append("")
        lines.append(f"Total employees in File 1: {comparison_result['total_file1']}")
        lines.append(f"Total employees in File 2: {comparison_result['total_file2']}")
        lines.append(f"Employees in both files: {comparison_result['matched']}")
        lines.append(f"Only in File 1: {comparison_result['only_in_file1']}")
        lines.append(f"Only in File 2: {comparison_result['only_in_file2']}")
        lines.append("")
        lines.append(f"Employees with differences: {comparison_result['with_differences']}")
        lines.append(f"Employees without differences: {comparison_result['without_differences']}")
        
        if comparison_result['statistics']:
            lines.append("")
            lines.append("Statistics:")
            stats = comparison_result['statistics']
            lines.append(f"  Maximum difference: {stats['max_difference']:,.2f}")
            lines.append(f"  Minimum difference: {stats['min_difference']:,.2f}")
            lines.append(f"  Average difference: {stats['avg_difference']:,.2f}")
            lines.append(f"  Total difference: {stats['total_difference']:,.2f}")
        
        lines.append("=" * 70)
        
        return "\n".join(lines)
