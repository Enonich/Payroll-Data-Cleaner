import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { Plus, X, Play, ChevronUp, ChevronDown } from 'lucide-react';
import DataTable from '../components/DataTable';
import {
  listFiles,
  getFilePreview,
  getFileData,
  getFileColumns,
  detectColumnTypes,
  applyColumnOperations,
  getColumnValues,
  enrichIdsByName,
  updateRows,
  reorderColumns,
  deleteColumn,
  addFormulaColumn,
} from '../services/api';

// All available cleaning operations with labels and descriptions
import { Maximize2 } from 'lucide-react';

const OPERATIONS = [
  {
    value: 'normalize_staff_id',
    label: 'Normalize Staff ID',
    desc: 'Remove .0 suffix (e.g. "10234.0" → "10234"), strip whitespace',
  },
  {
    value: 'clean_currency',
    label: 'Clean Currency',
    desc: 'Remove commas and currency symbols, convert dashes to 0',
  },
  {
    value: 'normalize_grade',
    label: 'Normalize Grade/Rank',
    desc: 'Uppercase, fix Roman numerals, collapse extra spaces',
  },
  {
    value: 'fix_branch',
    label: 'Fix Branch Names',
    desc: 'Correct known typos (e.g. ABOFOUR → ABOFFOUR)',
  },
  {
    value: 'strip_whitespace',
    label: 'Trim Whitespace',
    desc: 'Remove leading/trailing spaces from every value',
  },
  {
    value: 'uppercase',
    label: 'Uppercase',
    desc: 'Convert all values to UPPERCASE',
  },
  {
    value: 'lowercase',
    label: 'Lowercase',
    desc: 'Convert all values to lowercase',
  },
  {
    value: 'titlecase',
    label: 'Title Case',
    desc: 'Capitalise the First Letter Of Each Word',
  },
  {
    value: 'remove_nulls',
    label: 'Remove Empty Rows',
    desc: 'Drop any row where this column is blank or null',
  },
];

const TYPE_BADGE = {
  staff_id: { label: 'ID',       cls: 'bg-blue-100 text-blue-700' },
  currency:  { label: 'Currency', cls: 'bg-emerald-100 text-emerald-700' },
  grade:     { label: 'Grade',    cls: 'bg-purple-100 text-purple-700' },
  branch:    { label: 'Branch',   cls: 'bg-amber-100 text-amber-700' },
  name:      { label: 'Name',     cls: 'bg-pink-100 text-pink-700' },
};

// Suggested operations per detected type (for the hint in the dropdown)
const TYPE_SUGGESTIONS = {
  staff_id: 'normalize_staff_id',
  currency:  'clean_currency',
  grade:     'normalize_grade',
  branch:    'fix_branch',
  name:      'titlecase',
};

export default function Cleaning() {
  const { fileId } = useParams();
  const navigate = useNavigate();

  const [files, setFiles] = useState([]);
  const [selectedFile, setSelectedFile] = useState(fileId || '');
  const [preview, setPreview] = useState(null);
  const [fullData, setFullData] = useState([]);
  const [fullColumns, setFullColumns] = useState([]);
  const [loadingFullData, setLoadingFullData] = useState(false);
  const [columnTypes, setColumnTypes] = useState(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);

  // Each item: { id, column, operation }
  const [stagedOps, setStagedOps] = useState([]);

  // Which column's "add operation" panel is open
  const [expandedCol, setExpandedCol] = useState(null);
  // Selected operation for the expanded column
  const [pendingOp, setPendingOp] = useState('');
  // Cached sample values per column
  const [colSamples, setColSamples] = useState({});

  const [stripColNames, setStripColNames] = useState(false);

  const [referenceFileId, setReferenceFileId] = useState('');
  const [referenceColumns, setReferenceColumns] = useState([]);
  const [targetNameColumn, setTargetNameColumn] = useState('');
  const [referenceNameColumn, setReferenceNameColumn] = useState('');
  const [referenceIdColumn, setReferenceIdColumn] = useState('');
  const [outputIdColumn, setOutputIdColumn] = useState('Staff ID');
  const [overwriteExistingIds, setOverwriteExistingIds] = useState(false);
  const [useFuzzyMatching, setUseFuzzyMatching] = useState(true);
  const [fuzzyThreshold, setFuzzyThreshold] = useState('0.88');
  const [joiningIds, setJoiningIds] = useState(false);
  const [idJoinResult, setIdJoinResult] = useState(null);

  const [selectedRows, setSelectedRows] = useState([]);
  const [editField, setEditField] = useState('');
  const [editValue, setEditValue] = useState('');
  const [updatingRows, setUpdatingRows] = useState(false);

  const [draggingColumn, setDraggingColumn] = useState('');
  const [formulaColumnName, setFormulaColumnName] = useState('');
  const [formulaExpression, setFormulaExpression] = useState('');
  const [formulaOverwrite, setFormulaOverwrite] = useState(false);
  const [addingFormula, setAddingFormula] = useState(false);

  // In-cell editing state
  const [editingCell, setEditingCell] = useState(null); // { rowIndex, column }
  const [editingValue, setEditingValue] = useState('');
  const [savingCell, setSavingCell] = useState(false);

  useEffect(() => { loadFiles(); }, []);

  useEffect(() => {
    if (selectedFile) {
      loadFileData(selectedFile);
    } else {
      setPreview(null);
      setFullData([]);
      setFullColumns([]);
      setColumnTypes(null);
      setStagedOps([]);
      setExpandedCol(null);
      setColSamples({});
      setReferenceFileId('');
      setReferenceColumns([]);
      setTargetNameColumn('');
      setReferenceNameColumn('');
      setReferenceIdColumn('');
      setSelectedRows([]);
      setEditField('');
      setEditValue('');
      setIdJoinResult(null);
    }
  }, [selectedFile]);

  useEffect(() => {
    if (!referenceFileId) {
      setReferenceColumns([]);
      setReferenceNameColumn('');
      setReferenceIdColumn('');
      return;
    }

    const loadReferenceColumns = async () => {
      try {
        const data = await getFileColumns(referenceFileId);
        setReferenceColumns(data.columns || []);
      } catch {
        toast.error('Failed to load reference file columns');
      }
    };

    loadReferenceColumns();
  }, [referenceFileId]);

  const loadFiles = async () => {
    try {
      const data = await listFiles();
      setFiles(data.files);
      if (fileId && data.files.find(f => f.id === fileId)) {
        setSelectedFile(fileId);
      }
    } catch {
      toast.error('Failed to load files');
    }
  };

  const loadFileData = async (id) => {
    setLoading(true);
    try {
      const [previewData, typesData] = await Promise.all([
        getFilePreview(id, 50),
        detectColumnTypes(id),
      ]);

      setLoadingFullData(true);
      const dataResp = await getFileData(id, 0, 0);

      setPreview(previewData);
      setFullData(dataResp.data || []);
      setFullColumns(dataResp.columns || []);
      setColumnTypes(typesData);
      if (!targetNameColumn) {
        const suggestedName = (typesData?.recommendations?.name || [])[0] || '';
        setTargetNameColumn(suggestedName);
      }
      setSelectedRows([]);
      if (editField && !previewData.columns.includes(editField)) {
        setEditField('');
      }
    } catch {
      toast.error('Failed to load file data');
    } finally {
      setLoading(false);
      setLoadingFullData(false);
    }
  };

  const handleFileSelect = (e) => {
    const id = e.target.value;
    setSelectedFile(id);
    setStagedOps([]);
    setExpandedCol(null);
    setColSamples({});
    navigate(`/cleaning/${id}`);
  };

  // Toggle the add-operation panel for a column
  const handleToggleColumn = async (col) => {
    if (expandedCol === col) {
      setExpandedCol(null);
      return;
    }
    setExpandedCol(col);
    const detectedType = columnTypes?.detected_types?.[col];
    setPendingOp(TYPE_SUGGESTIONS[detectedType] || '');

    // Load sample values if not cached
    if (!colSamples[col] && selectedFile) {
      try {
        const data = await getColumnValues(selectedFile, col);
        setColSamples(prev => ({ ...prev, [col]: data }));
      } catch { /* non-fatal */ }
    }
  };

  const handleAddOp = () => {
    if (!expandedCol || !pendingOp) return;
    setStagedOps(prev => [
      ...prev,
      { id: Date.now(), column: expandedCol, operation: pendingOp },
    ]);
    setExpandedCol(null);
    setPendingOp('');
  };

  const handleRemoveOp = (id) => setStagedOps(prev => prev.filter(op => op.id !== id));

  const handleApply = async () => {
    if (!selectedFile || (stagedOps.length === 0 && !stripColNames)) {
      toast.error('No operations staged');
      return;
    }

    setApplying(true);
    try {
      const result = await applyColumnOperations(
        selectedFile,
        stagedOps.map(({ column, operation }) => ({ column, operation })),
        stripColNames
      );

      const errors = result.summary.filter(s => s.status === 'error');
      if (errors.length > 0) {
        errors.forEach(e => toast.error(`${e.column}: ${e.error}`));
      } else {
        toast.success(`Done — ${result.total_changes} value(s) changed`);
      }

      setStagedOps([]);
      setColSamples({});
      loadFileData(selectedFile);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to apply operations');
    } finally {
      setApplying(false);
    }
  };

  const toggleRowSelection = (rowIndex) => {
    setSelectedRows((prev) => {
      if (prev.includes(rowIndex)) {
        return prev.filter((idx) => idx !== rowIndex);
      }
      return [...prev, rowIndex];
    });
  };

  const handleSelectAllPreviewRows = () => {
    if (!preview?.data?.length) return;
    const allRows = preview.data.map((_, idx) => idx);
    const allSelected = allRows.every((idx) => selectedRows.includes(idx));
    setSelectedRows(allSelected ? [] : allRows);
  };

  const handleEnrichIds = async () => {
    if (!selectedFile || !referenceFileId) {
      toast.error('Select both target and reference files');
      return;
    }
    if (!targetNameColumn || !referenceNameColumn || !referenceIdColumn) {
      toast.error('Select the required name and ID columns');
      return;
    }

    setJoiningIds(true);
    try {
      const result = await enrichIdsByName({
        target_file_id: selectedFile,
        reference_file_id: referenceFileId,
        target_name_column: targetNameColumn,
        reference_name_column: referenceNameColumn,
        reference_id_column: referenceIdColumn,
        output_id_column: outputIdColumn || 'Staff ID',
        overwrite_existing: overwriteExistingIds,
        matching_mode: useFuzzyMatching ? 'fuzzy' : 'exact',
        fuzzy_threshold: useFuzzyMatching
          ? Math.max(0, Math.min(1, Number(fuzzyThreshold) || 0.88))
          : 1,
      });
      setIdJoinResult(result);
      setPreview(result.preview);
      toast.success(
        `IDs enriched: ${result.stats.matched_rows} matched (${result.stats.fuzzy_matched_rows || 0} fuzzy)`
      );
      loadFileData(selectedFile);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'ID enrichment failed');
    } finally {
      setJoiningIds(false);
    }
  };

  const handleApplyRowEdit = async () => {
    if (!selectedFile) {
      toast.error('Select a file first');
      return;
    }
    if (selectedRows.length === 0) {
      toast.error('Select at least one row');
      return;
    }
    if (!editField) {
      toast.error('Choose a field to update');
      return;
    }

    setUpdatingRows(true);
    try {
      const updates = selectedRows.map((rowIndex) => ({
        row_index: rowIndex,
        values: { [editField]: editValue },
      }));
      const result = await updateRows(selectedFile, updates);
      setPreview(result.preview);
      toast.success(`Updated ${result.cells_updated} cells`);
      setSelectedRows([]);
      loadFileData(selectedFile);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to update rows');
    } finally {
      setUpdatingRows(false);
    }
  };

  const handleDragStartColumn = (columnName) => setDraggingColumn(columnName);

  const handleDropColumn = async (targetColumn) => {
    if (!draggingColumn || draggingColumn === targetColumn || !selectedFile) {
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
      await reorderColumns(selectedFile, nextOrder);
      toast.success('Column order updated');
      loadFileData(selectedFile);
    } catch (e) {
      setFullColumns(previousOrder);
      toast.error(e.response?.data?.detail || 'Failed to reorder columns');
    }
  };

  const handleDeleteColumn = async (columnName) => {
    if (!selectedFile) return;
    const confirmed = window.confirm(`Delete column "${columnName}"?`);
    if (!confirmed) return;

    try {
      await deleteColumn(selectedFile, columnName);
      toast.success(`Deleted column: ${columnName}`);
      loadFileData(selectedFile);
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
    if (!editingCell || !selectedFile) return;

    setSavingCell(true);
    try {
      const update = {
        row_index: editingCell.rowIndex,
        values: { [editingCell.column]: editingValue },
      };
      const result = await updateRows(selectedFile, [update]);
      
      // Update local fullData optimistically
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

  const handleAddFormulaColumn = async () => {
    if (!selectedFile) {
      toast.error('Select a file first');
      return;
    }
    if (!formulaColumnName.trim() || !formulaExpression.trim()) {
      toast.error('Column name and formula are required');
      return;
    }

    setAddingFormula(true);
    try {
      const result = await addFormulaColumn({
        file_id: selectedFile,
        column_name: formulaColumnName.trim(),
        formula: formulaExpression.trim(),
        overwrite_existing: formulaOverwrite,
      });
      toast.success(`Formula column added: ${result.column_name}`);
      loadFileData(selectedFile);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to add formula column');
    } finally {
      setAddingFormula(false);
    }
  };

  const opLabel = (val) => OPERATIONS.find(o => o.value === val)?.label ?? val;
  const columns = preview?.columns || [];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Data Cleaning</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Pick any column, choose an operation, stage it, then apply.
        </p>
      </div>

      {/* File selector */}
      <div className="card p-4">
        <label className="block text-xs font-medium text-slate-600 mb-1.5">File</label>
        <select value={selectedFile} onChange={handleFileSelect} className="input">
          <option value="">Select a file…</option>
          {files.map(f => (
            <option key={f.id} value={f.id}>
              {f.filename} ({f.row_count.toLocaleString()} rows)
            </option>
          ))}
        </select>
      </div>

      {loading && (
        <div className="card p-8 text-center text-sm text-slate-500">Loading…</div>
      )}

      {!loading && selectedFile && columns.length > 0 && (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">

            {/* ── Column browser ── */}
            <div className="lg:col-span-3 card p-0 overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200">
                <h2 className="text-sm font-medium text-slate-900">
                  Columns <span className="text-slate-400 font-normal">({columns.length})</span>
                </h2>
                <span className="text-xs text-slate-400">Click + to add an operation</span>
              </div>

              <div className="max-h-[26rem] overflow-y-auto divide-y divide-slate-100">
                {columns.map(col => {
                  const type  = columnTypes?.detected_types?.[col];
                  const badge = TYPE_BADGE[type];
                  const open  = expandedCol === col;
                  const sample = colSamples[col];

                  return (
                    <div key={col}>
                      {/* Column row */}
                      <div className={`flex items-center gap-2 px-4 py-2 ${open ? 'bg-blue-50' : 'hover:bg-slate-50'}`}>
                        <span className="text-sm text-slate-700 flex-1 truncate" title={col}>{col}</span>
                        {badge && (
                          <span className={`badge ${badge.cls} flex-shrink-0`}>{badge.label}</span>
                        )}
                        <button
                          onClick={() => handleToggleColumn(col)}
                          className={`p-0.5 rounded transition-colors flex-shrink-0 ${
                            open
                              ? 'text-blue-600 hover:bg-blue-100'
                              : 'text-slate-400 hover:text-blue-600 hover:bg-blue-50'
                          }`}
                        >
                          {open ? <ChevronUp className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
                        </button>
                      </div>

                      {/* Inline add-operation panel */}
                      {open && (
                        <div className="bg-blue-50 px-4 py-3 space-y-2.5 border-t border-blue-100">
                          {/* Sample values */}
                          {sample && sample.sample_values.length > 0 && (
                            <p className="text-xs text-slate-500 leading-relaxed">
                              <span className="font-medium">Sample:</span>{' '}
                              {sample.sample_values.slice(0, 6).join(' · ')}
                              {sample.unique_count > 6 && (
                                <span className="text-slate-400"> (+{sample.unique_count - 6} more unique)</span>
                              )}
                            </p>
                          )}

                          {/* Operation picker */}
                          <div className="flex gap-2 items-start">
                            <div className="flex-1 space-y-1.5">
                              <select
                                value={pendingOp}
                                onChange={(e) => setPendingOp(e.target.value)}
                                className="input text-sm"
                              >
                                <option value="">Choose operation…</option>
                                {OPERATIONS.map(op => (
                                  <option key={op.value} value={op.value}>
                                    {op.label}
                                    {TYPE_SUGGESTIONS[type] === op.value ? ' ✓' : ''}
                                  </option>
                                ))}
                              </select>
                              {pendingOp && (
                                <p className="text-xs text-slate-500">
                                  {OPERATIONS.find(o => o.value === pendingOp)?.desc}
                                </p>
                              )}
                            </div>
                            <button
                              onClick={handleAddOp}
                              disabled={!pendingOp}
                              className="btn btn-primary disabled:opacity-40 flex-shrink-0"
                            >
                              Add
                            </button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* ── Staged operations queue ── */}
            <div className="lg:col-span-2 card p-4 flex flex-col">
              <h2 className="text-sm font-medium text-slate-900 mb-3">
                Staged Operations
                {stagedOps.length > 0 && (
                  <span className="ml-1.5 badge badge-blue">{stagedOps.length}</span>
                )}
              </h2>

              <div className="flex-1 min-h-0 max-h-72 overflow-y-auto space-y-1.5 mb-3">
                {stagedOps.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-6">
                    No operations staged yet.
                    <br />Click <strong>+</strong> on a column to add one.
                  </p>
                ) : (
                  stagedOps.map((op, idx) => (
                    <div
                      key={op.id}
                      className="flex items-center gap-2 px-2.5 py-2 bg-slate-50 rounded-md group"
                    >
                      <span className="text-xs text-slate-400 w-4 flex-shrink-0">{idx + 1}</span>
                      <div className="flex-1 min-w-0">
                        <p className="text-xs font-medium text-slate-800 truncate">{op.column}</p>
                        <p className="text-xs text-slate-500">{opLabel(op.operation)}</p>
                      </div>
                      <button
                        onClick={() => handleRemoveOp(op.id)}
                        className="p-0.5 text-slate-400 hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>

              {/* Global option + Apply */}
              <div className="border-t border-slate-200 pt-3 space-y-2.5">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={stripColNames}
                    onChange={(e) => setStripColNames(e.target.checked)}
                    className="rounded border-slate-300"
                  />
                  <span className="text-xs text-slate-600">Strip whitespace from column headers</span>
                </label>

                <button
                  onClick={handleApply}
                  disabled={applying || (stagedOps.length === 0 && !stripColNames)}
                  className="w-full btn btn-primary justify-center py-2 gap-1.5 disabled:opacity-40"
                >
                  <Play className="h-3.5 w-3.5" />
                  {applying
                    ? 'Applying…'
                    : `Apply${stagedOps.length > 0 ? ` (${stagedOps.length})` : ''}`}
                </button>

                {stagedOps.length > 0 && (
                  <button
                    onClick={() => setStagedOps([])}
                    className="w-full btn btn-secondary justify-center text-xs py-1.5"
                  >
                    Clear all
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Data preview */}
          <div className="card p-4">
            <h2 className="text-sm font-medium text-slate-900 mb-3">
              Preview{' '}
              {preview && (
                <span className="font-normal text-slate-500">({preview.total_rows} rows)</span>
              )}
            </h2>
            <DataTable data={preview.data} />
          </div>

          <div className="card p-4 space-y-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-medium text-slate-900">Full File Sheet (Excel Style)</h2>
                <p className="text-xs text-slate-500">
                  Drag a column header to reorder. Use header delete button to remove a column.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-slate-500">Rows: {fullData.length.toLocaleString()}</span>
                {selectedFile && (
                  <button
                    onClick={() => navigate(`/file-editor/${selectedFile}`)}
                    className="btn btn-secondary text-xs py-1.5 px-2"
                  >
                    Open Full Screen
                  </button>
                )}
              </div>
            </div>

            <div className="border border-slate-200 rounded-lg overflow-auto max-h-[34rem] bg-white">
              {loadingFullData ? (
                <div className="p-6 text-center text-sm text-slate-500">Loading full data...</div>
              ) : fullColumns.length === 0 ? (
                <div className="p-6 text-center text-sm text-slate-500">No data available</div>
              ) : (
                <table className="min-w-full text-xs">
                  <thead className="sticky top-0 bg-slate-100 z-10">
                    <tr>
                      <th className="px-2 py-2 text-left border-b border-r border-slate-200 w-14">#</th>
                      {fullColumns.map((col) => (
                        <th
                          key={col}
                          draggable
                          onDragStart={() => handleDragStartColumn(col)}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={() => handleDropColumn(col)}
                          className="px-2 py-2 text-left border-b border-r border-slate-200 min-w-[180px]"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <span className="truncate" title={col}>{col}</span>
                            <button
                              onClick={() => handleDeleteColumn(col)}
                              className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600 hover:bg-red-100"
                              title={`Delete ${col}`}
                            >
                              Del
                            </button>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {fullData.map((row, idx) => (
                      <tr key={idx} className={idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/60'}>
                        <td className="px-2 py-1.5 border-b border-r border-slate-100 text-slate-500">{idx}</td>
                                  {fullColumns.map((col) => {
                          const isEditing = editingCell?.rowIndex === idx && editingCell?.column === col;
                          return (
                            <td
                              key={`${idx}-${col}`}
                              className="px-2 py-1.5 border-b border-r border-slate-100"
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
                                  className="w-full px-1 py-0.5 border border-blue-400 rounded focus:outline-none focus:border-blue-600 text-sm"
                                />
                              ) : (
                                <span className="block whitespace-nowrap cursor-cell">
                                  {row[col] === null || row[col] === undefined || row[col] === ''
                                    ? '-'
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

          <div className="card p-4 space-y-3">
            <h2 className="text-sm font-medium text-slate-900">Add Formula Column</h2>
            <p className="text-xs text-slate-500">
              Create computed columns using other columns, for example: [Base Salary] + [Bonus]
            </p>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
              <input
                className="input"
                value={formulaColumnName}
                onChange={(e) => setFormulaColumnName(e.target.value)}
                placeholder="New column name"
              />
              <input
                className="input md:col-span-2"
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
                  className="text-[11px] px-2 py-1 rounded border border-slate-200 hover:bg-slate-50"
                >
                  [{col}]
                </button>
              ))}
            </div>

            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={formulaOverwrite}
                onChange={(e) => setFormulaOverwrite(e.target.checked)}
                className="rounded border-slate-300"
              />
              <span className="text-xs text-slate-600">Overwrite if column already exists</span>
            </label>

            <button onClick={handleAddFormulaColumn} disabled={addingFormula} className="btn btn-primary w-fit">
              {addingFormula ? 'Adding column...' : 'Add Formula Column'}
            </button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="card p-4 space-y-3">
              <h2 className="text-sm font-medium text-slate-900">Add Correct IDs By Name Match</h2>
              <p className="text-xs text-slate-500">
                Use a reference file that has employee names and valid IDs to populate the ID column in this file.
              </p>

              <select value={referenceFileId} onChange={(e) => setReferenceFileId(e.target.value)} className="input">
                <option value="">Reference file...</option>
                {files.filter((f) => f.id !== selectedFile).map((f) => (
                  <option key={f.id} value={f.id}>{f.filename}</option>
                ))}
              </select>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <select value={targetNameColumn} onChange={(e) => setTargetNameColumn(e.target.value)} className="input">
                  <option value="">Target name column...</option>
                  {columns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
                <input
                  className="input"
                  value={outputIdColumn}
                  onChange={(e) => setOutputIdColumn(e.target.value)}
                  placeholder="Output ID column"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <select value={referenceNameColumn} onChange={(e) => setReferenceNameColumn(e.target.value)} className="input">
                  <option value="">Reference name column...</option>
                  {referenceColumns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
                <select value={referenceIdColumn} onChange={(e) => setReferenceIdColumn(e.target.value)} className="input">
                  <option value="">Reference ID column...</option>
                  {referenceColumns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
              </div>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={overwriteExistingIds}
                  onChange={(e) => setOverwriteExistingIds(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-xs text-slate-600">Overwrite existing IDs</span>
              </label>

              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={useFuzzyMatching}
                  onChange={(e) => setUseFuzzyMatching(e.target.checked)}
                  className="rounded border-slate-300"
                />
                <span className="text-xs text-slate-600">Enable fuzzy name matching</span>
              </label>

              {useFuzzyMatching && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 items-center">
                  <label className="text-xs text-slate-600">Fuzzy threshold (0 to 1)</label>
                  <input
                    className="input"
                    value={fuzzyThreshold}
                    onChange={(e) => setFuzzyThreshold(e.target.value)}
                    placeholder="0.88"
                  />
                </div>
              )}

              <button onClick={handleEnrichIds} disabled={joiningIds} className="btn btn-primary">
                {joiningIds ? 'Matching names...' : 'Create/Update ID Column'}
              </button>

              {idJoinResult?.stats && (
                <div className="text-xs text-slate-600 space-y-1">
                  <p>Matched rows: {idJoinResult.stats.matched_rows}</p>
                  <p>Exact matches: {idJoinResult.stats.exact_matched_rows}</p>
                  <p>Fuzzy matches: {idJoinResult.stats.fuzzy_matched_rows}</p>
                  <p>Unmatched rows: {idJoinResult.stats.unmatched_rows}</p>
                  <p>Skipped existing IDs: {idJoinResult.stats.skipped_existing_ids}</p>
                </div>
              )}

              {idJoinResult?.fuzzy_match_samples?.length > 0 && (
                <div className="text-xs text-slate-600 space-y-1 border border-slate-200 rounded-md p-2">
                  <p className="font-medium text-slate-700">Sample fuzzy matches</p>
                  {idJoinResult.fuzzy_match_samples.slice(0, 5).map((sample, idx) => (
                    <p key={idx}>
                      {sample.target_name} → {sample.matched_reference_name} ({sample.score})
                    </p>
                  ))}
                </div>
              )}
            </div>

            <div className="card p-4 space-y-3">
              <h2 className="text-sm font-medium text-slate-900">Edit Selected Rows</h2>
              <p className="text-xs text-slate-500">
                Select specific rows from the preview and apply a field update to all selected rows.
              </p>

              <div className="flex items-center gap-2">
                <button onClick={handleSelectAllPreviewRows} className="btn btn-secondary text-xs">
                  {preview?.data?.length && preview.data.every((_, idx) => selectedRows.includes(idx))
                    ? 'Clear Selection'
                    : 'Select All Preview Rows'}
                </button>
                <span className="text-xs text-slate-500">Selected: {selectedRows.length}</span>
              </div>

              <div className="max-h-48 overflow-y-auto border border-slate-200 rounded-md">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 sticky top-0">
                    <tr>
                      <th className="px-2 py-1 text-left">Pick</th>
                      <th className="px-2 py-1 text-left">Row</th>
                      <th className="px-2 py-1 text-left">Sample</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(preview?.data || []).map((row, idx) => (
                      <tr key={idx} className="border-t border-slate-100">
                        <td className="px-2 py-1">
                          <input
                            type="checkbox"
                            checked={selectedRows.includes(idx)}
                            onChange={() => toggleRowSelection(idx)}
                          />
                        </td>
                        <td className="px-2 py-1 text-slate-600">{idx}</td>
                        <td className="px-2 py-1 text-slate-600 truncate max-w-[220px]">
                          {Object.values(row).slice(0, 3).map((v) => String(v ?? '')).join(' | ')}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                <select value={editField} onChange={(e) => setEditField(e.target.value)} className="input">
                  <option value="">Field to update...</option>
                  {columns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
                <input
                  className="input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder="New value"
                />
              </div>

              <button onClick={handleApplyRowEdit} disabled={updatingRows} className="btn btn-primary">
                {updatingRows ? 'Applying edits...' : 'Apply Edit to Selected Rows'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

