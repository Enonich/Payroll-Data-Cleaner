import pandas as pd

from app.services.file_service import FileService


def test_get_sheet_names_releases_excel_file_for_deletion(tmp_path):
    filepath = tmp_path / "payroll.xlsx"
    pd.DataFrame({"employee_id": [1]}).to_excel(filepath, index=False)

    assert FileService.get_sheet_names_from_path(filepath, ".xlsx") == ["Sheet1"]

    filepath.unlink()
    assert not filepath.exists()


def test_read_file_drops_columns_with_blank_excel_headers(tmp_path):
    filepath = tmp_path / "payroll.xlsx"
    pd.DataFrame(
        [[1, 100, 200]],
        columns=["Employee ID", "", None],
    ).to_excel(filepath, index=False)

    dataframe, _ = FileService.read_file(filepath, filepath.name)

    assert dataframe.columns.tolist() == ["Employee ID"]


def test_drop_unnamed_columns_preserves_explicitly_named_columns():
    dataframe = pd.DataFrame(
        columns=["Employee ID", "Unnamed: 41", "Unnamed: 41.1", "Unnamed Employee"],
    )

    cleaned = FileService._drop_unnamed_columns(dataframe)

    assert cleaned.columns.tolist() == ["Employee ID", "Unnamed Employee"]