import { useState, useEffect, useRef, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
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
  deleteRows,
  reorderColumns,
  deleteColumn,
  addFormulaColumn,
  addColumn,
  fillSequence,
} from '../services/api';

import {
  Play,
  X,
  Plus,
  ChevronDown,
  ChevronRight,
  Hash,
  DollarSign,
  User,
  MapPin,
  Flag,
  Type,
  Trash2,
  GripVertical,
  PanelRightOpen,
  PanelRightClose,
  FileSpreadsheet,
  Columns2,
  CheckSquare,
} from 'lucide-react';
import FormField, { FieldTooltip } from '../components/FormField';

const OPERATIONS = [
  { value: 'normalize_staff_id', label: 'Normalize Staff ID', icon: Hash, color: 'bg-blue-100 text-blue-700' },
  { value: 'clean_currency',     label: 'Clean Currency',     icon: DollarSign, color: 'bg-emerald-100 text-emerald-700' },
  { value: 'normalize_grade',    label: 'Normalize Grade',     icon: User, color: 'bg-purple-100 text-purple-700' },
  { value: 'fix_branch',         label: 'Fix Branch Names',    icon: MapPin, color: 'bg-amber-100 text-amber-700' },
  { value: 'strip_whitespace',   label: 'Trim Whitespace',     icon: Type, color: 'bg-slate-100 text-slate-700' },
  { value: 'uppercase',          label: 'Uppercase',           icon: Flag, color: 'bg-pink-100 text-pink-700' },
  { value: 'lowercase',          label: 'Lowercase',           icon: Flag, color: 'bg-pink-100 text-pink-700' },
  { value: 'titlecase',          label: 'Title Case',          icon: Flag, color: 'bg-pink-100 text-pink-700' },
  { value: 'remove_nulls',       label: 'Remove Empty Rows',   icon: X, color: 'bg-red-100 text-red-700' },
];

const TYPE_BADGE = {
  staff_id: { label: 'ID',       cls: 'bg-blue-100 text-blue-700' },
  currency:  { label: 'Currency', cls: 'bg-emerald-100 text-emerald-700' },
  grade:     { label: 'Grade',    cls: 'bg-purple-100 text-purple-700' },
  branch:    { label: 'Branch',   cls: 'bg-amber-100 text-amber-700' },
  name:      { label: 'Name',     cls: 'bg-pink-100 text-pink-700' },
};

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
  const [loading, setLoading] = useState(false);
  const [loadingFullData, setLoadingFullData] = useState(false);
  const [columnTypes, setColumnTypes] = useState(null);

  // Staged operations
  const [stagedOps, setStagedOps] = useState([]);
  const [stripColNames, setStripColNames] = useState(false);
  const [applying, setApplying] = useState(false);

  // Column context menu
  const [contextMenu, setContextMenu] = useState(null); // { col, x, y }
  const [pendingOp, setPendingOp] = useState('');
  const [addingColumn, setAddingColumn] = useState(false);

  // Side panel
  const [showPanel, setShowPanel] = useState(false);
  const [panelTab, setPanelTab] = useState('edit'); // edit | enrich | formula

  // Row selection
  const [selectedRows, setSelectedRows] = useState([]);
  const [editField, setEditField] = useState('');
  const [editValue, setEditValue] = useState('');
  const [updatingRows, setUpdatingRows] = useState(false);

  // ID enrichment
  const [referenceFileId, setReferenceFileId] = useState('');
  const [referenceColumns, setReferenceColumns] = useState([]);
  const [targetNameColumn, setTargetNameColumn] = useState('');
  const [referenceNameColumn, setReferenceNameColumn] = useState('');
  const [referenceIdColumn, setReferenceIdColumn] = useState('');
  const [outputIdColumn, setOutputIdColumn] = useState('Staff ID');
  const [overwriteExistingIds, setOverwriteExistingIds] = useState(false);
  const [useFuzzyMatching, setUseFuzzyMatching] = useState(true);
  const [fuzzyThreshold, setFuzzyThreshold] = useState('0.88');
  const [useFirstLastMatching, setUseFirstLastMatching] = useState(false);
  const [referenceFirstNameColumn, setReferenceFirstNameColumn] = useState('');
  const [referenceSurnameColumn, setReferenceSurnameColumn] = useState('');
  const [joiningIds, setJoiningIds] = useState(false);
  const [idJoinResult, setIdJoinResult] = useState(null);

  // Formula
  const [formulaColumnName, setFormulaColumnName] = useState('');
  const [formulaExpression, setFormulaExpression] = useState('');
  const [formulaOverwrite, setFormulaOverwrite] = useState(false);
  const [addingFormula, setAddingFormula] = useState(false);

  // Sequence Autofill ID
  const [sequenceTargetMode, setSequenceTargetMode] = useState('existing'); // existing | new
  const [sequenceTargetColumn, setSequenceTargetColumn] = useState('');
  const [sequenceNewColumnName, setSequenceNewColumnName] = useState('');
  const [sequencePrefix, setSequencePrefix] = useState('');
  const [sequenceStartNumber, setSequenceStartNumber] = useState('');
  const [sequenceOverwrite, setSequenceOverwrite] = useState(false);
  const [fillingSequence, setFillingSequence] = useState(false);

  // Dragging columns
  const [dragFrom, setDragFrom] = useState(null);
  const [dragTarget, setDragTarget] = useState(null);

  // In-cell editing
  const [editingCell, setEditingCell] = useState(null);
  const [editingValue, setEditingValue] = useState('');
  const [savingCell, setSavingCell] = useState(false);

  const contextRef = useRef(null);

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
      setContextMenu(null);
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

  // Close context menu on outside click
  useEffect(() => {
    const handler = (e) => {
      if (contextRef.current && !contextRef.current.contains(e.target)) {
        setContextMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const loadFiles = async () => {
    try {
      const data = await listFiles();
      setFiles(data.files);
      if (fileId && data.files.find(f => f.id === fileId)) setSelectedFile(fileId);
    } catch { toast.error('Failed to load files'); }
  };

  const loadFileData = async (id) => {
    setLoading(true);
    try {
      const [previewData, typesData, dataResp] = await Promise.all([
        getFilePreview(id, 50),
        detectColumnTypes(id),
        getFileData(id, 0, 0),
      ]);
      setPreview(previewData);
      setFullData(dataResp.data || []);
      setFullColumns(dataResp.columns || []);
      setColumnTypes(typesData);
      setSelectedRows([]);
      setContextMenu(null);
    } catch { toast.error('Failed to load file data'); }
    finally { setLoading(false); setLoadingFullData(false); }
  };

  // Lighter refresh that skips column-type detection (for row/cell edits)
  const refreshData = async (id) => {
    try {
      const [previewData, dataResp] = await Promise.all([
        getFilePreview(id, 50),
        getFileData(id, 0, 0),
      ]);
      setPreview(previewData);
      setFullData(dataResp.data || []);
      setFullColumns(dataResp.columns || []);
    } catch { /* non-fatal, data already visible */ }
  };

  const handleFileSelect = (e) => {
    const id = e.target.value;
    setSelectedFile(id);
    setStagedOps([]);
    navigate(`/cleaning/${id}`);
  };

  // ─── Column context menu ───────────────────────────────────────────────
  const handleColumnContextMenu = (col, e) => {
    e.preventDefault();
    const detectedType = columnTypes?.detected_types?.[col];
    setPendingOp(TYPE_SUGGESTIONS[detectedType] || '');
    setContextMenu({ col, x: e.clientX, y: e.clientY });
  };

  const handleAddOpFromMenu = () => {
    if (!contextMenu || !pendingOp) return;
    setStagedOps(prev => [...prev, { id: Date.now(), column: contextMenu.col, operation: pendingOp }]);
    setContextMenu(null);
    setPendingOp('');
  };

  const handleAddQuickOp = (operation) => {
    if (!contextMenu?.col) return;
    setStagedOps(prev => [...prev, { id: Date.now(), column: contextMenu.col, operation }]);
    setContextMenu(null);
    setPendingOp('');
  };

  const handleInsertColumnNear = async (position) => {
    if (!selectedFile || !contextMenu?.col) return;

    const sideLabel = position === 'left' ? 'left of' : 'right of';
    const suggested = position === 'left'
      ? `${contextMenu.col}_new_left`
      : `${contextMenu.col}_new_right`;
    const nameInput = window.prompt(
      `New column name (${sideLabel} "${contextMenu.col}")`,
      suggested
    );

    if (!nameInput) return;
    const newColumnName = nameInput.trim();
    if (!newColumnName) {
      toast.error('Column name cannot be empty');
      return;
    }

    setAddingColumn(true);
    try {
      await addColumn(selectedFile, newColumnName, contextMenu.col, position);
      setOutputIdColumn(newColumnName);
      setShowPanel(true);
      setPanelTab('enrich');
      setContextMenu(null);
      toast.success(`Added column: ${newColumnName}`);
      await loadFileData(selectedFile);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to add column');
    } finally {
      setAddingColumn(false);
    }
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
      if (errors.length > 0) errors.forEach(e => toast.error(`${e.column}: ${e.error}`));
      else toast.success(`Done — ${result.total_changes} value(s) changed`);
      setStagedOps([]);
      loadFileData(selectedFile);
    } catch (e) { toast.error(e.response?.data?.detail || 'Failed to apply operations'); }
    finally { setApplying(false); }
  };

  // ─── Column reorder (drag) ────────────────────────────────────────────
  const handleDragStart = (col) => { setDragFrom(col); setDragTarget(null); };
  const handleDragOver = (e, col) => {
    e.preventDefault();
    if (!dragFrom || dragFrom === col) return;
    setDragTarget(col); // just track target, don't reorder yet
  };
  const handleDragEnd = async () => {
    const from = dragFrom;
    const to = dragTarget;
    setDragFrom(null);
    setDragTarget(null);
    if (!from || !to || from === to || !selectedFile) return;
    // Compute new order only once, at drop time
    const cols = [...fullColumns];
    const fromIdx = cols.indexOf(from);
    const toIdx = cols.indexOf(to);
    if (fromIdx < 0 || toIdx < 0) return;
    cols.splice(fromIdx, 1);
    cols.splice(toIdx, 0, from);
    setFullColumns(cols);
    try {
      await reorderColumns(selectedFile, cols);
      toast.success('Column order updated');
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to reorder columns');
      loadFileData(selectedFile); // revert to server state on error
    }
  };

  const handleDeleteColumn = async (col) => {
    if (!selectedFile) return;
    if (!window.confirm(`Delete column "${col}"?`)) return;
    try {
      await deleteColumn(selectedFile, col);
      toast.success(`Deleted column: ${col}`);
      loadFileData(selectedFile);
    } catch (e) { toast.error(e.response?.data?.detail || 'Failed to delete column'); }
  };

  // ─── In-cell editing ───────────────────────────────────────────────────
  const handleCellDoubleClick = (rowIndex, column) => {
    setEditingCell({ rowIndex, column });
    setEditingValue(String(fullData[rowIndex]?.[column] ?? ''));
  };
  const handleCellKeyDown = async (e) => {
    if (!editingCell) return;
    if (e.key === 'Enter') { e.preventDefault(); await handleSaveCell(); }
    else if (e.key === 'Escape') { e.preventDefault(); setEditingCell(null); setEditingValue(''); }
  };
  const handleSaveCell = async () => {
    if (!editingCell || !selectedFile) return;
    setSavingCell(true);
    const prevValue = fullData[editingCell.rowIndex]?.[editingCell.column];
    // Optimistic update first
    const newData = [...fullData];
    if (newData[editingCell.rowIndex]) newData[editingCell.rowIndex][editingCell.column] = editingValue;
    setFullData(newData);
    setEditingCell(null);
    setEditingValue('');
    try {
      await updateRows(selectedFile, [{
        row_index: editingCell.rowIndex,
        values: { [editingCell.column]: editingValue }
      }]);
    } catch (e) {
      // Revert on failure
      const revertData = [...fullData];
      if (revertData[editingCell.rowIndex]) revertData[editingCell.rowIndex][editingCell.column] = prevValue;
      setFullData(revertData);
      toast.error(e.response?.data?.detail || 'Failed to save cell');
    }
    finally { setSavingCell(false); }
  };

  // ─── Row selection ─────────────────────────────────────────────────────
  const toggleRowSelection = (idx) => {
    setSelectedRows(prev => prev.includes(idx) ? prev.filter(i => i !== idx) : [...prev, idx]);
  };
  const handleSelectAll = () => {
    if (!fullData.length) return;
    const all = fullData.map((_, idx) => idx);
    setSelectedRows(prev => prev.length === all.length ? [] : all);
  };

  const handleApplyRowEdit = async () => {
    if (!selectedFile || selectedRows.length === 0 || !editField) {
      toast.error('Select rows and a field');
      return;
    }
    setUpdatingRows(true);
    try {
      const result = await updateRows(selectedFile, selectedRows.map(rowIndex => ({
        row_index: rowIndex,
        values: { [editField]: editValue }
      })));
      toast.success(`Updated ${result.cells_updated} cells`);
      setSelectedRows([]);
      refreshData(selectedFile);
    } catch (e) { toast.error(e.response?.data?.detail || 'Failed to update rows'); }
    finally { setUpdatingRows(false); }
  };

  const handleDeleteRows = async () => {
    if (!selectedFile || selectedRows.length === 0) return;
    if (!window.confirm(`Delete ${selectedRows.length} selected row(s)? This cannot be undone.`)) return;
    setUpdatingRows(true);
    try {
      const result = await deleteRows(selectedFile, selectedRows);
      toast.success(`Deleted ${result.rows_deleted} row(s). ${result.remaining_rows.toLocaleString()} remaining.`);
      setSelectedRows([]);
      setEditField('');
      setEditValue('');
      await refreshData(selectedFile);
    } catch (e) { toast.error(e.response?.data?.detail || 'Failed to delete rows'); }
    finally { setUpdatingRows(false); }
  };

  // ─── ID enrichment ─────────────────────────────────────────────────────
  const handleEnrichIds = async () => {
    if (!selectedFile || !referenceFileId || !targetNameColumn || !referenceNameColumn || !referenceIdColumn) {
      toast.error('Fill all required fields');
      return;
    }
    if (useFirstLastMatching && (!referenceFirstNameColumn || !referenceSurnameColumn)) {
      toast.error('Select both first name and surname columns for first+last matching');
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
        matching_mode: useFirstLastMatching ? 'first_last' : (useFuzzyMatching ? 'fuzzy' : 'exact'),
        fuzzy_threshold: (useFuzzyMatching || useFirstLastMatching) ? Math.max(0, Math.min(1, Number(fuzzyThreshold) || 0.88)) : 1,
        ...(useFirstLastMatching && {
          reference_first_name_column: referenceFirstNameColumn,
          reference_surname_column: referenceSurnameColumn,
        }),
      });
      setIdJoinResult(result);
      toast.success(`IDs enriched: ${result.stats.matched_rows} matched`);
      loadFileData(selectedFile);
    } catch (e) { toast.error(e.response?.data?.detail || 'ID enrichment failed'); }
    finally { setJoiningIds(false); }
  };

  // ─── Formula ───────────────────────────────────────────────────────────
  const handleAddFormulaColumn = async () => {
    if (!selectedFile || !formulaColumnName.trim() || !formulaExpression.trim()) {
      toast.error('Column name and formula are required');
      return;
    }
    setAddingFormula(true);
    try {
      await addFormulaColumn({
        file_id: selectedFile,
        column_name: formulaColumnName.trim(),
        formula: formulaExpression.trim(),
        overwrite_existing: formulaOverwrite,
      });
      toast.success('Formula column added');
      loadFileData(selectedFile);
    } catch (e) { toast.error(e.response?.data?.detail || 'Failed to add formula column'); }
    finally { setAddingFormula(false); }
  };
  const handleInsertColumnToken = (col) => {
    const token = `[${col}]`;
    setFormulaExpression(prev => !prev ? token : `${prev} ${token}`);
  };

  const handleFillSequence = async () => {
    const colName = sequenceTargetMode === 'new' ? sequenceNewColumnName.trim() : sequenceTargetColumn;
    if (!selectedFile || !colName) {
      toast.error('Please select or specify a target column');
      return;
    }
    if (!sequenceStartNumber.trim()) {
      toast.error('Please specify a starting employee ID number');
      return;
    }
    setFillingSequence(true);
    try {
      await fillSequence({
        file_id: selectedFile,
        column_name: colName,
        prefix: sequencePrefix,
        start_number: sequenceStartNumber.trim(),
        overwrite_existing: sequenceOverwrite,
      });
      toast.success('Sequence populated successfully');
      loadFileData(selectedFile);
    } catch (e) {
      toast.error(e.response?.data?.detail || 'Failed to populate sequence');
    } finally {
      setFillingSequence(false);
    }
  };

  const columns = preview?.columns || [];
  const opLabel = (val) => OPERATIONS.find(o => o.value === val)?.label || val;
  const opIcon = (val) => {
    const op = OPERATIONS.find(o => o.value === val);
    if (!op) return null;
    const Icon = op.icon;
    return <Icon className="h-3 w-3" />;
  };

  return (
    <div className="flex gap-0 -mt-5 -mx-5" style={{ minHeight: 'calc(100vh - 2.75rem)' }}>
      {/* ── Sheet area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top command bar - fixed to viewport width, independent of sheet/table width */}
        <div
          className="sticky top-0 z-30 w-full max-w-full shrink-0 border-b shadow-sm"
          style={{ backgroundColor: 'var(--color-card)', borderColor: 'var(--color-border)' }}
        >
          <div className="w-full max-w-full overflow-x-auto">
            <div className="min-w-0 px-4 py-2 flex items-center gap-2">
              <select
                value={selectedFile}
                onChange={handleFileSelect}
                className="input w-[260px] max-w-[260px] text-xs"
                style={{ padding: '0.25rem 0.5rem' }}
              >
                <option value="">Select a file...</option>
                {files.map(f => (
                  <option key={f.id} value={f.id}>{f.filename} ({f.row_count.toLocaleString()} rows)</option>
                ))}
              </select>

              <div className="w-px h-5 bg-slate-200 mx-1" />

              <button
                onClick={handleApply}
                disabled={applying || (stagedOps.length === 0 && !stripColNames)}
                className="btn btn-primary text-xs py-1 px-3 gap-1 disabled:opacity-40"
              >
                <Play className="h-3 w-3" />
                {applying ? 'Applying...' : 'Apply'}
              </button>

              <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer shrink-0">
                <input
                  type="checkbox"
                  checked={stripColNames}
                  onChange={(e) => setStripColNames(e.target.checked)}
                  className="w-3 h-3"
                />
                Strip headers
              </label>

              {stagedOps.length > 0 && (
                <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-2 py-1 min-w-0 max-w-[420px]">
                  <span className="text-[11px] font-medium text-slate-700 shrink-0">{stagedOps.length} staged</span>
                  <div className="flex items-center gap-1 overflow-x-auto">
                    {stagedOps.slice(0, 4).map((op) => (
                      <span
                        key={op.id}
                        className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded bg-white text-slate-700 border border-slate-200 shrink-0"
                      >
                        {opIcon(op.operation)}
                        <span className="max-w-[80px] truncate">{op.column}</span>
                        <button onClick={() => handleRemoveOp(op.id)} className="text-slate-400 hover:text-red-500">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                    {stagedOps.length > 4 && (
                      <span className="text-[10px] text-slate-500 px-1 shrink-0">+{stagedOps.length - 4}</span>
                    )}
                  </div>
                </div>
              )}

              <div className="flex-1" />

              <button
                onClick={() => { setShowPanel(!showPanel); setPanelTab('enrich'); }}
                className="btn btn-secondary text-xs py-1 px-2"
                title={showPanel ? 'Close tools' : 'Open tools'}
              >
                {showPanel ? <PanelRightClose className="h-3.5 w-3.5" /> : <PanelRightOpen className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div className="w-full max-w-full border-t" style={{ borderColor: '#bfdbfe' }}>
            <div className="w-full max-w-full overflow-x-auto">
              <div className="min-w-0 px-4 py-2 flex items-center gap-2 text-xs" style={{ backgroundColor: '#f8fbff' }}>
                <CheckSquare className="h-3.5 w-3.5 text-blue-600 flex-shrink-0" />
                <span className="font-semibold text-blue-700 shrink-0">
                  {selectedRows.length} row{selectedRows.length !== 1 ? 's' : ''} selected
                </span>

                <div className="w-px h-4 bg-blue-200 mx-1" />

                <button
                  onClick={handleDeleteRows}
                  disabled={updatingRows || selectedRows.length === 0}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 disabled:opacity-50 transition-colors shrink-0"
                >
                  <Trash2 className="h-3 w-3" />
                  Delete rows
                </button>

                <button
                  onClick={handleSelectAll}
                  disabled={!fullData.length}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-slate-700 bg-white hover:bg-slate-50 border border-slate-200 disabled:opacity-50 transition-colors shrink-0"
                >
                  <CheckSquare className="h-3 w-3" />
                  {selectedRows.length === fullData.length && fullData.length > 0 ? 'Unselect all' : 'Select all'}
                </button>

                <span className="text-blue-600 font-medium shrink-0">Set value:</span>
                <select
                  value={editField}
                  onChange={(e) => setEditField(e.target.value)}
                  disabled={selectedRows.length === 0}
                  className="input text-xs py-0.5 shrink-0 disabled:opacity-60"
                  style={{ padding: '0.2rem 0.4rem', width: '150px' }}
                >
                  <option value="">Field...</option>
                  {columns.map(col => <option key={col} value={col}>{col}</option>)}
                </select>
                <span className="text-blue-400 shrink-0">=</span>
                <input
                  className="input text-xs py-0.5 shrink-0 disabled:opacity-60"
                  style={{ padding: '0.2rem 0.4rem', width: '150px' }}
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  placeholder="New value..."
                  disabled={selectedRows.length === 0}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleApplyRowEdit(); }}
                />
                <button
                  onClick={handleApplyRowEdit}
                  disabled={updatingRows || !editField || selectedRows.length === 0}
                  className="flex items-center gap-1 px-2 py-1 rounded text-xs font-medium text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors shrink-0"
                >
                  <Play className="h-3 w-3" />
                  {updatingRows ? 'Updating...' : 'Apply'}
                </button>

                {selectedRows.length > 0 && (
                  <button
                    onClick={() => setSelectedRows([])}
                    className="flex items-center gap-1 text-blue-500 hover:text-blue-700 px-1 shrink-0"
                    title="Clear row selection"
                  >
                    <X className="h-3.5 w-3.5" />
                    <span className="text-[11px]">Clear</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Spreadsheet */}
        <div className="flex-1 overflow-auto" style={{ backgroundColor: 'var(--color-surface)' }}>
          {loading && <div className="p-8 text-center text-sm text-slate-500">Loading…</div>}

          {!loading && selectedFile && fullColumns.length > 0 && (
            <div className="inline-block min-w-full align-middle">
              <table className="w-full text-xs border-collapse" style={{ fontVariationSettings: "'opsz' 10" }}>
                <thead>
                  {/* Column headers */}
                  <tr>
                    <th className="sticky top-0 z-20 px-1 py-1 border-b border-r text-center text-[10px] text-slate-500 bg-slate-100 w-8"
                        style={{ minWidth: '2rem' }}>
                      <input type="checkbox" checked={selectedRows.length === fullData.length && fullData.length > 0}
                             onChange={handleSelectAll} className="w-3 h-3" />
                    </th>
                    <th className="sticky top-0 z-20 px-1.5 py-1 border-b border-r text-[10px] text-slate-500 bg-slate-100 w-10">#</th>
                    {fullColumns.map((col) => {
                      const type = columnTypes?.detected_types?.[col];
                      const badge = TYPE_BADGE[type];
                      return (
                        <th key={col}
                            className="sticky top-0 z-20 px-2 py-1 border-b border-r bg-slate-100 font-normal select-none cursor-context-menu"
                            draggable
                            onDragStart={() => handleDragStart(col)}
                            onDragOver={(e) => handleDragOver(e, col)}
                            onDragEnd={handleDragEnd}
                            style={{ opacity: dragTarget === col && dragFrom && dragFrom !== col ? 0.55 : 1 }}
                            onContextMenu={(e) => handleColumnContextMenu(col, e)}
                            style={{ minWidth: '140px', maxWidth: '300px' }}>
                          <div className="flex items-center gap-1.5">
                            <GripVertical className="h-2.5 w-2.5 text-slate-300 flex-shrink-0 cursor-grab" />
                            <span className="truncate flex-1 text-[11px] text-slate-700 font-medium">{col}</span>
                            {badge && <span className={`text-[9px] px-1 py-px rounded-full ${badge.cls} flex-shrink-0`}>{badge.label}</span>}
                            <button onClick={() => handleDeleteColumn(col)}
                                    className="text-slate-300 hover:text-red-500 flex-shrink-0 opacity-0 hover:opacity-100 transition-opacity">
                              <Trash2 className="h-2.5 w-2.5" />
                            </button>
                          </div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {fullData.map((row, idx) => (
                    <tr key={idx}
                        className={`${selectedRows.includes(idx) ? 'bg-blue-50' : idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/40'}`}>
                      <td className="px-1 py-0 border-b border-r text-center">
                        <input type="checkbox" checked={selectedRows.includes(idx)}
                               onChange={() => toggleRowSelection(idx)} className="w-3 h-3" />
                      </td>
                      <td className="px-1.5 py-0 border-b border-r text-slate-400 text-right text-[10px]">{idx}</td>
                      {fullColumns.map((col) => {
                        const isEditing = editingCell?.rowIndex === idx && editingCell?.column === col;
                        const val = row[col];
                        return (
                          <td key={`${idx}-${col}`}
                              className="px-2 py-0.5 border-b border-r cursor-cell"
                              onDoubleClick={() => handleCellDoubleClick(idx, col)}
                              style={{ maxWidth: '300px', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {isEditing ? (
                              <input autoFocus type="text" value={editingValue}
                                     onChange={(e) => setEditingValue(e.target.value)}
                                     onKeyDown={handleCellKeyDown}
                                     onBlur={handleSaveCell}
                                     disabled={savingCell}
                                     className="w-full px-1 py-0 border border-blue-400 rounded text-xs outline-none focus:border-blue-600" />
                            ) : (
                              <span className="block truncate text-[12px]" title={val === null || val === undefined || val === '' ? '-' : String(val)}>
                                {val === null || val === undefined || val === '' ? <span className="text-slate-300">-</span> : String(val)}
                              </span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!loading && selectedFile && fullColumns.length === 0 && (
            <div className="p-12 text-center">
              <FileSpreadsheet className="h-10 w-10 mx-auto text-slate-300 mb-3" />
              <p className="text-sm text-slate-500">Select a file above to view its data</p>
            </div>
          )}
        </div>

        {/* Status bar */}
        <div className="flex items-center gap-3 px-3 py-1 border-t shrink-0 text-[11px] text-slate-500"
             style={{ backgroundColor: 'var(--color-card)', borderColor: 'var(--color-border)' }}>
          <span>Rows: {fullData.length.toLocaleString()}</span>
          <span>Cols: {fullColumns.length}</span>
          {selectedRows.length > 0 && <span>Selected: {selectedRows.length}</span>}
          {stagedOps.length > 0 && <span>Staged: {stagedOps.length}</span>}
          <div className="flex-1" />
          {selectedFile && (
            <button onClick={() => navigate(`/file-editor/${selectedFile}`)}
                    className="text-accent hover:underline">Full Screen</button>
          )}
        </div>
      </div>

      {/* ── Side panel ── */}
      {showPanel && (
        <div className="sticky top-0 self-start w-72 shrink-0 border-l overflow-y-auto"
             style={{ backgroundColor: 'var(--color-card)', borderColor: 'var(--color-border)', maxHeight: '100vh' }}>
          {/* Tabs */}
          <div className="flex border-b" style={{ borderColor: 'var(--color-border)' }}>
            {[
              { id: 'enrich', label: 'ID Match' },
              { id: 'formula', label: 'Formula' },
              { id: 'sequence', label: 'Autofill ID' },
            ].map(tab => (
              <button key={tab.id}
                      onClick={() => setPanelTab(tab.id)}
                      className={`flex-1 text-xs py-2 font-medium transition-colors ${
                        panelTab === tab.id
                          ? 'text-accent border-b-2 border-accent'
                          : 'text-slate-500 hover:text-slate-700'
                      }`}>
                {tab.label}
              </button>
            ))}
          </div>

          <div className="p-3 space-y-3">
            {/* ── ID Match tab ── */}
            {panelTab === 'enrich' && (
              <>
                <p className="text-[11px] text-slate-500 leading-5">
                  Fill missing staff IDs by matching employee names in this file against a reference file that already has names and IDs.
                </p>

                <FormField
                  label="Reference file"
                  tooltip="The lookup file that already contains correct employee names and their staff IDs."
                  tooltipPlacement="right"
                >
                  <select value={referenceFileId} onChange={(e) => setReferenceFileId(e.target.value)} className="input text-xs">
                    <option value="">Select reference file...</option>
                    {files.filter(f => f.id !== selectedFile).map(f => (
                      <option key={f.id} value={f.id}>{f.filename}</option>
                    ))}
                  </select>
                </FormField>

                <FormField
                  label="Name column in current file"
                  tooltip="Employee names in the file you are cleaning. Each row is matched against names in the reference file."
                  tooltipPlacement="right"
                >
                  <select value={targetNameColumn} onChange={(e) => setTargetNameColumn(e.target.value)} className="input text-xs">
                    <option value="">Select name column...</option>
                    {columns.map(col => <option key={col} value={col}>{col}</option>)}
                  </select>
                </FormField>

                <FormField
                  label="Output ID column"
                  tooltip="Where matched staff IDs are written. This column is created automatically if it does not exist yet."
                  tooltipPlacement="right"
                >
                  <input className="input text-xs" value={outputIdColumn}
                         onChange={(e) => setOutputIdColumn(e.target.value)} placeholder="e.g. Staff ID" />
                </FormField>

                <FormField
                  label="Name column in reference file"
                  tooltip="The name column in the reference file that corresponds to names in your current file."
                  tooltipPlacement="right"
                >
                  <select value={referenceNameColumn} onChange={(e) => setReferenceNameColumn(e.target.value)} className="input text-xs">
                    <option value="">Select reference name column...</option>
                    {referenceColumns.map(col => <option key={col} value={col}>{col}</option>)}
                  </select>
                </FormField>

                <FormField
                  label="ID column in reference file"
                  tooltip="The staff ID copied into the output column whenever a name match is found."
                  tooltipPlacement="right"
                >
                  <select value={referenceIdColumn} onChange={(e) => setReferenceIdColumn(e.target.value)} className="input text-xs">
                    <option value="">Select reference ID column...</option>
                    {referenceColumns.map(col => <option key={col} value={col}>{col}</option>)}
                  </select>
                </FormField>

                <label className="flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={overwriteExistingIds}
                         onChange={(e) => setOverwriteExistingIds(e.target.checked)} className="w-3 h-3" />
                  <span className="font-medium">Overwrite existing IDs</span>
                  <FieldTooltip
                    label="Overwrite existing IDs"
                    text="Replace IDs that are already present in the output column. Leave unchecked to only fill empty cells."
                    placement="right"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={useFuzzyMatching}
                         onChange={(e) => { setUseFuzzyMatching(e.target.checked); if (e.target.checked) setUseFirstLastMatching(false); }}
                         className="w-3 h-3" />
                  <span className="font-medium">Fuzzy name matching</span>
                  <FieldTooltip
                    label="Fuzzy name matching"
                    text="Allows near-matches when names differ slightly in spelling, order, or formatting."
                    placement="right"
                  />
                </label>
                {useFuzzyMatching && (
                  <FormField
                    label="Match threshold"
                    tooltip="Value from 0 to 1. Higher values require closer name matches; lower values allow more variation."
                    tooltipPlacement="right"
                  >
                    <input className="input text-xs" value={fuzzyThreshold}
                           onChange={(e) => setFuzzyThreshold(e.target.value)} placeholder="0.88" />
                  </FormField>
                )}

                <label className="flex items-center gap-1.5 text-[11px] text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={useFirstLastMatching}
                         onChange={(e) => { setUseFirstLastMatching(e.target.checked); if (e.target.checked) setUseFuzzyMatching(false); }}
                         className="w-3 h-3" />
                  <span className="font-medium">Match by first name + surname</span>
                  <FieldTooltip
                    label="Match by first name + surname"
                    text="Select dedicated first-name and surname columns from the reference file. Checks whether both tokens appear in the target's full name — ideal when long names with many middle names cause whole-name fuzzy matching to fail."
                    placement="right"
                  />
                </label>
                {useFirstLastMatching && (
                  <>
                    <FormField
                      label="First name column (reference)"
                      tooltip="Column in the reference file containing only the employee's first name."
                      tooltipPlacement="right"
                    >
                      <select value={referenceFirstNameColumn}
                              onChange={(e) => setReferenceFirstNameColumn(e.target.value)}
                              className="input text-xs">
                        <option value="">Select first name column…</option>
                        {referenceColumns.map(col => <option key={col} value={col}>{col}</option>)}
                      </select>
                    </FormField>
                    <FormField
                      label="Surname column (reference)"
                      tooltip="Column in the reference file containing only the employee's surname / last name."
                      tooltipPlacement="right"
                    >
                      <select value={referenceSurnameColumn}
                              onChange={(e) => setReferenceSurnameColumn(e.target.value)}
                              className="input text-xs">
                        <option value="">Select surname column…</option>
                        {referenceColumns.map(col => <option key={col} value={col}>{col}</option>)}
                      </select>
                    </FormField>
                    <FormField
                      label="Match threshold"
                      tooltip="Minimum score (0–1) for both the first name and surname to match against tokens in the target name."
                      tooltipPlacement="right"
                    >
                      <input className="input text-xs" value={fuzzyThreshold}
                             onChange={(e) => setFuzzyThreshold(e.target.value)} placeholder="0.88" />
                    </FormField>
                  </>
                )}

                <button onClick={handleEnrichIds} disabled={joiningIds}
                        className="btn btn-primary w-full text-xs justify-center disabled:opacity-40">
                  {joiningIds ? 'Matching…' : 'Fill IDs from Reference File'}
                </button>
                {idJoinResult?.stats && (
                  <div className="text-[11px] text-slate-600 space-y-0.5 bg-slate-50 rounded p-2">
                    <p>Matched: {idJoinResult.stats.matched_rows} ({idJoinResult.stats.exact_matched_rows || 0} exact, {idJoinResult.stats.token_sort_matched_rows || 0} reordered, {idJoinResult.stats.fuzzy_matched_rows || 0} fuzzy, {idJoinResult.stats.first_last_matched_rows || 0} first+last)</p>
                    <p>Unmatched: {idJoinResult.stats.unmatched_rows}</p>
                    <p>Skipped: {idJoinResult.stats.skipped_existing_ids}</p>
                  </div>
                )}
              </>
            )}

            {/* ── Formula tab ── */}
            {panelTab === 'formula' && (
              <>
                <p className="text-[11px] text-slate-500">Add a computed column, e.g. <code className="text-xs">[Base] + [Bonus]</code></p>
                <input className="input text-xs" value={formulaColumnName}
                       onChange={(e) => setFormulaColumnName(e.target.value)} placeholder="New column name" />
                <input className="input text-xs" value={formulaExpression}
                       onChange={(e) => setFormulaExpression(e.target.value)} placeholder="Formula expression" />
                <div className="flex flex-wrap gap-1">
                  {fullColumns.slice(0, 12).map(col => (
                    <button key={col} onClick={() => handleInsertColumnToken(col)}
                            className="text-[9px] px-1.5 py-0.5 rounded border hover:bg-slate-50">
                      {col.length > 14 ? col.slice(0, 12) + '…' : col}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={formulaOverwrite}
                         onChange={(e) => setFormulaOverwrite(e.target.checked)} className="w-3 h-3" />
                  Overwrite if exists
                </label>
                <button onClick={handleAddFormulaColumn} disabled={addingFormula}
                        className="btn btn-primary w-full text-xs justify-center disabled:opacity-40">
                  {addingFormula ? 'Adding…' : 'Add Formula Column'}
                </button>
              </>
            )}

            {/* ── Sequence Autofill tab ── */}
            {panelTab === 'sequence' && (
              <>
                <p className="text-[11px] text-slate-500">Populate a column with a sequential staff ID (e.g., fixed prefix + auto-incrementing employee number).</p>
                <div className="flex gap-2">
                  <label className="flex items-center gap-1 text-[11px] text-slate-600 cursor-pointer">
                    <input type="radio" name="sequenceTargetMode" value="existing"
                           checked={sequenceTargetMode === 'existing'} onChange={() => setSequenceTargetMode('existing')} className="w-3 h-3" />
                    Existing column
                  </label>
                  <label className="flex items-center gap-1 text-[11px] text-slate-600 cursor-pointer">
                    <input type="radio" name="sequenceTargetMode" value="new"
                           checked={sequenceTargetMode === 'new'} onChange={() => setSequenceTargetMode('new')} className="w-3 h-3" />
                    New column
                  </label>
                </div>

                {sequenceTargetMode === 'existing' ? (
                  <select value={sequenceTargetColumn} onChange={(e) => setSequenceTargetColumn(e.target.value)} className="input text-xs">
                    <option value="">Select column to fill…</option>
                    {columns.map(col => (
                      <option key={col} value={col}>{col}</option>
                    ))}
                  </select>
                ) : (
                  <input className="input text-xs" value={sequenceNewColumnName}
                         onChange={(e) => setSequenceNewColumnName(e.target.value)} placeholder="New column name" />
                )}

                <div className="grid grid-cols-2 gap-1.5">
                  <div>
                    <label className="block text-[10px] font-medium text-slate-500 mb-0.5">Fixed Prefix</label>
                    <input className="input text-xs" value={sequencePrefix}
                           onChange={(e) => setSequencePrefix(e.target.value)} placeholder="e.g. EMP-" />
                  </div>
                  <div>
                    <label className="block text-[10px] font-medium text-slate-500 mb-0.5">First Employee ID</label>
                    <input className="input text-xs" value={sequenceStartNumber}
                           onChange={(e) => setSequenceStartNumber(e.target.value)} placeholder="e.g. 001" />
                  </div>
                </div>

                <label className="flex items-center gap-1.5 text-[11px] text-slate-600 cursor-pointer">
                  <input type="checkbox" checked={sequenceOverwrite}
                         onChange={(e) => setSequenceOverwrite(e.target.checked)} className="w-3 h-3" />
                  Overwrite if exists
                </label>

                <button onClick={handleFillSequence} disabled={fillingSequence}
                        className="btn btn-primary w-full text-xs justify-center disabled:opacity-40">
                  {fillingSequence ? 'Generating…' : 'Autofill Column'}
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {/* ── Column context menu ── */}
      {contextMenu && (
        <div ref={contextRef}
             className="fixed z-50 bg-white rounded-lg shadow-xl border py-1 min-w-[180px]"
             style={{ left: contextMenu.x, top: contextMenu.y, borderColor: 'var(--color-border)' }}>
          <div className="px-3 py-1.5 text-[11px] font-medium text-slate-500 border-b truncate"
               style={{ borderColor: 'var(--color-border)' }}>
            {contextMenu.col}
          </div>
          <div className="px-2 py-1">
            <select value={pendingOp} onChange={(e) => setPendingOp(e.target.value)}
                    className="input text-xs mb-1.5">
              <option value="">Choose operation…</option>
              {OPERATIONS.map(op => (
                <option key={op.value} value={op.value}>{op.label}</option>
              ))}
            </select>
            <button onClick={handleAddOpFromMenu} disabled={!pendingOp}
                    className="btn btn-primary w-full text-xs justify-center py-1 disabled:opacity-40">
              Add Operation
            </button>
          </div>
          <div className="border-t px-2 py-1 space-y-1" style={{ borderColor: 'var(--color-border)' }}>
            <div className="text-[10px] uppercase tracking-wide text-slate-400 px-2 py-0.5">
              Quick Column Edits
            </div>
            {OPERATIONS.map((op) => (
              <button
                key={op.value}
                onClick={() => handleAddQuickOp(op.value)}
                className="flex items-center gap-1.5 text-xs text-slate-700 hover:bg-slate-50 w-full px-2 py-1 rounded"
              >
                <op.icon className="h-3 w-3" />
                {op.label}
              </button>
            ))}
          </div>
          <div className="border-t px-2 py-1 space-y-1" style={{ borderColor: 'var(--color-border)' }}>
            <div className="text-[10px] uppercase tracking-wide text-slate-400 px-2 py-0.5">
              Insert Empty Column
            </div>
            <button
              onClick={() => handleInsertColumnNear('left')}
              disabled={addingColumn}
              className="flex items-center gap-1.5 text-xs text-slate-700 hover:bg-slate-50 w-full px-2 py-1 rounded disabled:opacity-50"
            >
              <Columns2 className="h-3 w-3" />
              Add Column To Left
            </button>
            <button
              onClick={() => handleInsertColumnNear('right')}
              disabled={addingColumn}
              className="flex items-center gap-1.5 text-xs text-slate-700 hover:bg-slate-50 w-full px-2 py-1 rounded disabled:opacity-50"
            >
              <Columns2 className="h-3 w-3" />
              Add Column To Right
            </button>
          </div>
          <div className="border-t px-2 py-1" style={{ borderColor: 'var(--color-border)' }}>
            <button onClick={() => { handleDeleteColumn(contextMenu.col); setContextMenu(null); }}
                    className="flex items-center gap-1.5 text-xs text-red-600 hover:bg-red-50 w-full px-2 py-1 rounded">
              <Trash2 className="h-3 w-3" />
              Delete column
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
