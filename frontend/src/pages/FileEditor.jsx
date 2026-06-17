import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { ArrowLeft, Trash2, Plus } from 'lucide-react';
import {
  listFiles,
  getFileData,
  updateRows,
  reorderColumns,
  deleteColumn,
  addFormulaColumn,
} from '../services/api';

export default function FileEditor() {
  const { fileId } = useParams();
  const navigate = useNavigate();

  const [fileInfo, setFileInfo] = useState(null);
  const [fullData, setFullData] = useState([]);
  const [fullColumns, setFullColumns] = useState([]);
  const [loading, setLoading] = useState(true);

  // In-cell editing state
  const [editingCell, setEditingCell] = useState(null);
  const [editingValue, setEditingValue] = useState('');
  const [savingCell, setSavingCell] = useState(false);

  // Column drag & drop
  const [draggingColumn, setDraggingColumn] = useState('');

  // Add formula column
  const [showFormulaPanel, setShowFormulaPanel] = useState(false);
  const [formulaColumnName, setFormulaColumnName] = useState('');
  const [formulaExpression, setFormulaExpression] = useState('');
  const [formulaOverwrite, setFormulaOverwrite] = useState(false);
  const [addingFormula, setAddingFormula] = useState(false);

  useEffect(() => {
    loadFileData();
  }, [fileId]);

  const loadFileData = async () => {
    if (!fileId) {
      toast.error('No file ID provided');
      navigate('/cleaning');
      return;
    }

    setLoading(true);
    try {
      const files = await listFiles();
      const file = files.files?.find((f) => f.id === fileId);
      if (!file) {
        toast.error('File not found');
        navigate('/cleaning');
        return;
      }
      setFileInfo(file);

      const dataResp = await getFileData(fileId, 0, 0);
      setFullData(dataResp.data || []);
      setFullColumns(dataResp.columns || []);
    } catch (e) {
      toast.error('Failed to load file');
      navigate('/cleaning');
    } finally {
      setLoading(false);
    }
  };

  const handleCellDoubleClick = (rowIndex, column) => {
    setEditingCell({ rowIndex, column });
    setEditingValue(String(fullData[rowIndex]?.[column] ?? ''));
  };

  const handleCellKeyDown = async (e) => {
    if (!editingCell) return;

    if (e.key === 'Enter') {
      e.preventDefault();
      await handleSaveCell();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setEditingCell(null);
      setEditingValue('');
    }
  };

  const handleSaveCell = async () => {
    if (!editingCell || !fileId) return;

    setSavingCell(true);
    try {
      const update = {
        row_index: editingCell.rowIndex,
        values: { [editingCell.column]: editingValue },
      };
      await updateRows(fileId, [update]);

      const newData = [...fullData];
      if (newData[editingCell.rowIndex]) {
        newData[editingCell.rowIndex][editingCell.column] = editingValue;
        setFullData(newData);
      }

      setEditingCell(null);
      setEditingValue('');
      toast.success('Cell saved');
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to save cell');
    } finally {
      setSavingCell(false);
    }
  };

  const handleDragStartColumn = (columnName) => setDraggingColumn(columnName);

  const handleDropColumn = async (targetColumn) => {
    if (!draggingColumn || draggingColumn === targetColumn || !fileId) {
      setDraggingColumn('');
      return;
    }

    const fromIndex = fullColumns.indexOf(draggingColumn);
    const toIndex = fullColumns.indexOf(targetColumn);
    if (fromIndex < 0 || toIndex < 0) {
      setDraggingColumn('');
      return;
    }

    const nextOrder = [...fullColumns];
    nextOrder.splice(fromIndex, 1);
    nextOrder.splice(toIndex, 0, draggingColumn);

    const previousOrder = fullColumns;
    setFullColumns(nextOrder);
    setDraggingColumn('');

    try {
      await reorderColumns(fileId, nextOrder);
      toast.success('Columns reordered');
    } catch (e) {
      setFullColumns(previousOrder);
      toast.error(e.response?.data?.detail || 'Failed to reorder columns');
    }
  };

  const handleDeleteColumn = async (columnName) => {
    if (!fileId) return;
    const confirmed = window.confirm(`Delete column "${columnName}"?`);
    if (!confirmed) return;

    try {
      await deleteColumn(fileId, columnName);
      toast.success(`Deleted: ${columnName}`);
      loadFileData();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to delete column');
    }
  };

  const handleInsertColumnToken = (columnName) => {
    const token = `[${columnName}]`;
    setFormulaExpression((prev) => {
      if (!prev) return token;
      return `${prev} ${token}`;
    });
  };

  const handleAddFormulaColumn = async () => {
    if (!fileId) {
      toast.error('No file selected');
      return;
    }
    if (!formulaColumnName.trim() || !formulaExpression.trim()) {
      toast.error('Column name and formula are required');
      return;
    }

    setAddingFormula(true);
    try {
      await addFormulaColumn({
        file_id: fileId,
        column_name: formulaColumnName.trim(),
        formula: formulaExpression.trim(),
        overwrite_existing: formulaOverwrite,
      });
      toast.success(`Added: ${formulaColumnName}`);
      setFormulaColumnName('');
      setFormulaExpression('');
      setShowFormulaPanel(false);
      loadFileData();
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to add formula column');
    } finally {
      setAddingFormula(false);
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center">
        <div className="text-sm text-slate-500">Loading file...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Header */}
      <div className="sticky top-0 z-20 bg-white border-b border-slate-200 shadow-sm">
        <div className="px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button
              onClick={() => navigate('/cleaning')}
              className="p-1.5 rounded hover:bg-slate-100 text-slate-600"
              title="Back to Cleaning"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div>
              <h1 className="text-lg font-semibold text-slate-900">
                {fileInfo?.filename || 'File Editor'}
              </h1>
              <p className="text-xs text-slate-500">
                {fullData.length.toLocaleString()} rows · {fullColumns.length} columns
              </p>
            </div>
          </div>
          <button
            onClick={() => setShowFormulaPanel(!showFormulaPanel)}
            className="btn btn-secondary text-sm gap-1.5"
          >
            <Plus className="h-3.5 w-3.5" />
            Formula Column
          </button>
        </div>
      </div>

      {/* Main content */}
      <div className="p-5">
        {/* Formula panel */}
        {showFormulaPanel && (
          <div className="mb-4 card p-4 space-y-3 bg-blue-50 border border-blue-200">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-slate-900">Add Formula Column</h3>
              <button
                onClick={() => setShowFormulaPanel(false)}
                className="text-slate-400 hover:text-slate-600"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
              <input
                className="input"
                value={formulaColumnName}
                onChange={(e) => setFormulaColumnName(e.target.value)}
                placeholder="Column name"
              />
              <input
                className="input md:col-span-3"
                value={formulaExpression}
                onChange={(e) => setFormulaExpression(e.target.value)}
                placeholder="Formula e.g. [Base Salary] + [Bonus]"
              />
            </div>

            <div className="flex flex-wrap gap-1.5">
              {fullColumns.map((col) => (
                <button
                  key={col}
                  onClick={() => handleInsertColumnToken(col)}
                  className="text-[11px] px-2 py-1 rounded border border-slate-300 hover:bg-slate-100"
                >
                  [{col}]
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={formulaOverwrite}
                  onChange={(e) => setFormulaOverwrite(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-xs text-slate-600">Overwrite existing</span>
              </label>
              <button
                onClick={handleAddFormulaColumn}
                disabled={addingFormula}
                className="btn btn-primary text-sm py-1.5 px-3"
              >
                {addingFormula ? 'Adding...' : 'Add Column'}
              </button>
            </div>
          </div>
        )}

        {/* Spreadsheet */}
        <div className="card p-0 overflow-auto max-h-[calc(100vh-200px)] rounded-lg border border-slate-200">
          {fullColumns.length === 0 ? (
            <div className="p-8 text-center text-sm text-slate-500">No data available</div>
          ) : (
            <table className="min-w-full text-sm bg-white">
              <thead className="sticky top-0 bg-slate-100 z-10 border-b border-slate-200">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-slate-700 border-r border-slate-200 w-14 bg-slate-100">
                    #
                  </th>
                  {fullColumns.map((col) => (
                    <th
                      key={col}
                      draggable
                      onDragStart={() => handleDragStartColumn(col)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => handleDropColumn(col)}
                      className="px-3 py-2 text-left text-xs font-medium text-slate-700 border-r border-slate-200 min-w-[200px] bg-slate-100 cursor-grab active:cursor-grabbing"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate" title={col}>
                          {col}
                        </span>
                        <button
                          onClick={() => handleDeleteColumn(col)}
                          className="p-0.5 rounded text-red-500 hover:bg-red-50 opacity-0 hover:opacity-100 transition-opacity"
                          title={`Delete ${col}`}
                        >
                          <Trash2 className="h-3 w-3" />
                        </button>
                      </div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {fullData.map((row, idx) => (
                  <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50'}>
                    <td className="px-3 py-1.5 text-xs text-slate-500 border-r border-slate-200 bg-slate-50 sticky left-0">
                      {idx}
                    </td>
                    {fullColumns.map((col) => {
                      const isEditing = editingCell?.rowIndex === idx && editingCell?.column === col;
                      return (
                        <td
                          key={`${idx}-${col}`}
                          className="px-3 py-1.5 border-r border-slate-200 border-b border-slate-100"
                          onDoubleClick={() => handleCellDoubleClick(idx, col)}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              type="text"
                              value={editingValue}
                              onChange={(e) => setEditingValue(e.target.value)}
                              onKeyDown={handleCellKeyDown}
                              onBlur={handleSaveCell}
                              disabled={savingCell}
                              className="w-full px-2 py-1 border border-blue-400 rounded text-sm focus:outline-none focus:border-blue-600"
                            />
                          ) : (
                            <span className="block whitespace-nowrap cursor-cell hover:bg-blue-50 px-1 py-0.5 rounded">
                              {row[col] === null || row[col] === undefined || row[col] === ''
                                ? '—'
                                : String(row[col])}
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
