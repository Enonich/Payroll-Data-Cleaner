from app.services.comparison_service import ComparisonService
from app.services.reconciliation_service import ReconciliationService
import pandas as pd


def test_compare_employee_data_without_name_mapping():
    df1 = pd.DataFrame([
        {"id": "EMP001", "name": "John Doe", "Total Allowance": 500.0},
        {"id": "EMP002", "name": "Jane Smith", "Total Allowance": 600.0},
    ])
    df2 = pd.DataFrame([
        {"id": "EMP001", "name": "John  Doe", "Taxable Allowance": 500.0}, # Name has extra space
        {"id": "EMP002", "name": "Jane Smith", "Taxable Allowance": 650.0}, # Difference of 50.0
    ])

    column_mappings = [
        {"file1": "Total Allowance", "file2": "Taxable Allowance", "label": "Total Allowance / Taxable Allowance", "type": "currency"}
    ]

    result = ComparisonService.compare_employee_data(
        df1, df2,
        id_col1="id", id_col2="id",
        column_mappings=column_mappings,
        name_col1="name", name_col2="name",
        normalize_ids=True,
        keep_digits=0,
        tolerance=0.01,
        match_unmatched_by_name=False
    )

    mismatches = result["mismatches_df"]
    assert len(mismatches) == 1
    assert mismatches.iloc[0]["employee_id"] == "EMP002"
    assert mismatches.iloc[0]["field"] == "Total Allowance / Taxable Allowance"
    assert mismatches.iloc[0]["difference"] == 50.0


def test_name_column_can_also_be_the_employee_id_column():
    df1 = pd.DataFrame([{"Name": "Alice Smith", "5% PF": 100.0}])
    df2 = pd.DataFrame([{"Name": "Alice Smith", "Tier 3 Provident Fund Employer": 120.0}])

    result = ComparisonService.compare_employee_data(
        df1,
        df2,
        id_col1="Name",
        id_col2="Name",
        column_mappings=[{
            "file1": "5% PF",
            "file2": "Tier 3 Provident Fund Employer",
            "label": "5% PF / Tier 3 Provident Fund Employer",
            "type": "currency",
        }],
        name_col1="Name",
        name_col2="Name",
    )

    mismatch = result["mismatches_df"].iloc[0]
    assert mismatch["file1_id"] == "Alice Smith"
    assert mismatch["file2_id"] == "Alice Smith"
    assert mismatch["file1_name"] == "Alice Smith"
    assert mismatch["file2_name"] == "Alice Smith"


def test_text_mappings_treat_empty_dash_and_formatted_amounts_as_numeric_equivalents():
    df1 = pd.DataFrame([
        {"id": "EMP001", "Allowance": "0.00"},
        {"id": "EMP002", "Allowance": ""},
        {"id": "EMP003", "Allowance": "1,540.00"},
        {"id": "EMP004", "Allowance": "1,540.00"},
        {"id": "EMP005", "Allowance": "001"},
    ])
    df2 = pd.DataFrame([
        {"id": "EMP001", "Allowance": "-"},
        {"id": "EMP002", "Allowance": "0"},
        {"id": "EMP003", "Allowance": "1540"},
        {"id": "EMP004", "Allowance": "1,500.00"},
        {"id": "EMP005", "Allowance": "1"},
    ])

    result = ComparisonService.compare_employee_data(
        df1,
        df2,
        id_col1="id",
        id_col2="id",
        column_mappings=[{"file1": "Allowance", "file2": "Allowance", "type": "text"}],
    )

    assert result["mismatches_df"]["employee_id"].tolist() == ["EMP004", "EMP005"]


def test_name_based_audit_compares_mapped_fields_for_id_unmatched_employees():
    df1 = pd.DataFrame([
        {"id": "OLD-100", "name": "Rosemary Appiah", "Fuel": 500.0},
        {"id": "SAME-200", "name": "Regular Person", "Fuel": 10.0},
        {"id": "ONLY-1", "name": "Unpaired One", "Fuel": 100.0},
    ])
    df2 = pd.DataFrame([
        {"id": "NEW-100", "name": "Appiah  Rosemary", "Fuel": 600.0},
        {"id": "SAME-200", "name": "Regular Person", "Fuel": 25.0},
        {"id": "ONLY-2", "name": "Unpaired Two", "Fuel": 100.0},
    ])

    result = ComparisonService.compare_employee_data(
        df1,
        df2,
        id_col1="id",
        id_col2="id",
        column_mappings=[{"file1": "Fuel", "file2": "Fuel", "label": "Fuel", "type": "currency"}],
        name_col1="name",
        name_col2="name",
        match_unmatched_by_name=True,
    )

    mismatches = result["mismatches_df"]
    name_matched_issues = mismatches[mismatches["employee_id"] == "NEW-100"]
    assert result["matched_by_name"] == 1
    assert result["matched"] == 1
    assert set(name_matched_issues["field"]) == {"Employee ID", "Fuel"}
    assert name_matched_issues.loc[name_matched_issues["field"] == "Fuel", "difference"].iloc[0] == 100.0
    assert "SAME-200" not in mismatches["employee_id"].tolist()
    assert result["only_in_file1_df"]["id"].tolist() == ["ONLY-1"]
    assert result["only_in_file2_df"]["id"].tolist() == ["ONLY-2"]


def test_issue_rows_without_presence_issues():
    result = {
        "mismatches_df": pd.DataFrame([
            {
                "employee_id": "EMP001",
                "field": "Total Allowance / Taxable Allowance",
                "file1_value": 500.0,
                "file2_value": 600.0,
                "file1_name": "John Doe",
                "file2_name": "John Doe",
            }
        ]),
        "only_in_file1_df": pd.DataFrame([{"id": "EMP003", "name": "Sam Solo"}]),
        "only_in_file2_df": pd.DataFrame([{"id": "EMP004", "name": "New Person"}]),
    }

    issues_with_presence = ReconciliationService._issue_rows_from_result(
        result, "File 1", "File 2", include_presence_issues=True
    )
    issues_without_presence = ReconciliationService._issue_rows_from_result(
        result, "File 1", "File 2", include_presence_issues=False
    )

    # With presence issues: 1 field mismatch + 2 presence issues (Employee Status)
    assert len(issues_with_presence) == 3
    assert any(i["field"] == "Employee Status" for i in issues_with_presence)

    # Without presence issues (Column comparison mode): ONLY 1 field mismatch, 0 Employee Status issues
    assert len(issues_without_presence) == 1
    assert issues_without_presence[0]["field"] == "Total Allowance / Taxable Allowance"
    assert not any(i["field"] == "Employee Status" for i in issues_without_presence)
