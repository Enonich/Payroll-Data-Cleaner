from unittest.mock import patch

import pandas as pd

from app.services.reconciliation_service import ReconciliationService


def test_investigation_export_creates_three_normalized_datasets():
    issues = [
        {
            "employee_id": "66922",
            "employee_name": "Enoch Owusu Okyere",
            "issue_type": "allowance_change",
            "field": "Taxable Allowance",
            "old_value": "0",
            "new_value": "830.88",
            "difference": 830.88,
            "status": "open",
            "explanation": "Allowance differs.",
            "source": {
                "file1_column": "Taxable Allowance",
                "file2_column": "Taxable Allowance",
                "file1_value": 0,
                "file2_value": 830.88,
            },
        },
        {
            "employee_id": "66922",
            "employee_name": "Enoch Owusu Okyere",
            "issue_type": "deduction_change",
            "field": "Provident Fund Deduction",
            "old_value": "375.292125",
            "new_value": "0",
            "difference": -375.292125,
            "status": "open",
            "explanation": "Deduction differs.",
            "source": {
                "file1_column": "Provident Fund",
                "file2_column": "Provident Fund",
                "file1_value": 375.292125,
                "file2_value": 0,
            },
        },
        {
            "employee_id": "66922",
            "employee_name": "Enoch Owusu Okyere",
            "issue_type": "take_home_change",
            "field": "Take Home",
            "old_value": "9247.28",
            "new_value": "9257.79",
            "difference": 10.51,
            "status": "open",
            "explanation": "Take home differs.",
            "source": {
                "file1_column": "Net Pay",
                "file2_column": "Net Pay",
                "file1_value": 9247.28,
                "file2_value": 9257.79,
            },
        },
        {
            "employee_id": "66922",
            "employee_name": "Enoch Owusu Okyere",
            "issue_type": "field_mismatch",
            "field": "Employee Name",
            "old_value": "ENOCH OWUSU OKYERE",
            "new_value": "Enoch Owusu Okyere",
            "difference": None,
            "status": "open",
            "explanation": "Name formatting differs.",
            "source": {
                "file1_column": "STAFF NAMES",
                "file2_column": "Name",
                "file1_value": "ENOCH OWUSU OKYERE",
                "file2_value": "Enoch Owusu Okyere",
            },
        },
    ]
    run = {
        "id": "run-1",
        "source_file1_id": "source-1",
        "source_file2_id": "payroll-1",
        "file1_label": "HR Source",
        "file2_label": "Payroll May2026",
        "created_at": "2026-09-15T10:00:00",
        "issues": issues,
    }
    bundle = {
        "employee_id": "66922",
        "employee_name": "Enoch Owusu Okyere",
        "file1_rows": [{
            "Employee ID": "66922",
            "STAFF NAMES": "ENOCH OWUSU OKYERE",
            "Basic Salary": 7505.84,
            "Taxable Allowance": 0,
            "Provident Fund": 375.292125,
            "Net Pay": 9247.28,
        }],
        "file2_rows": [{
            "Employee ID": "66922",
            "Name": "Enoch Owusu Okyere",
            "Basic Salary": 7505.84,
            "Taxable Allowance": 830.88,
            "Provident Fund": 0,
            "Net Pay": 9257.79,
        }],
        "issues": issues,
    }
    generated = {}

    def capture_file(dataframe, filename):
        generated[filename] = dataframe.copy()
        return filename

    with (
        patch.object(ReconciliationService, "get_run", return_value=run),
        patch.object(ReconciliationService, "get_employee_bundle", return_value=bundle),
        patch.object(ReconciliationService, "_record_audit"),
        patch("app.services.reconciliation_service.FileService.get_file_info", side_effect=[
            {"filename": "hr_source.csv"},
            {"filename": "Payroll_May2026.csv"},
        ]),
        patch("app.services.reconciliation_service.FileService.create_new_file", side_effect=capture_file),
    ):
        result = ReconciliationService.export_investigated_differences("run-1", ["66922"])

    assert set(result["files"]) == {
        "payroll_difference_summary",
        "payroll_difference_details",
        "payroll_employee_comparison",
    }
    assert set(generated) == {
        "payroll_difference_summary_2026-05.csv",
        "payroll_difference_details_2026-05.csv",
        "payroll_employee_comparison_2026-05.csv",
    }

    details = generated["payroll_difference_details_2026-05.csv"]
    assert details.columns.tolist() == [
        "employee_id", "employee_name", "difference_type", "field_name",
        "source_value", "payroll_value", "numeric_difference", "source_column",
        "payroll_column", "source_file", "payroll_file", "financial_impact",
        "status", "investigation_note",
    ]
    assert details["difference_type"].tolist() == [
        "allowance_difference", "deduction_difference", "take_home_difference", "name_mismatch"
    ]

    summary = generated["payroll_difference_summary_2026-05.csv"].iloc[0]
    assert summary["difference_count"] == 4
    assert summary["allowance_differences"] == 1
    assert summary["deduction_differences"] == 1
    assert summary["field_mismatches"] == 1
    assert summary["take_home_difference"] == 10.51

    comparison = generated["payroll_employee_comparison_2026-05.csv"]
    basic_salary = comparison[comparison["field_name"] == "Basic Salary"].iloc[0]
    taxable_allowance = comparison[comparison["field_name"] == "Taxable Allowance"].iloc[0]
    assert basic_salary["match"] == "Yes"
    assert taxable_allowance["difference"] == 830.88
    assert taxable_allowance["match"] == "No"