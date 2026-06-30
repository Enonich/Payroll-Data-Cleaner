import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import DataTable from '../components/DataTable';
import FormField, { FieldTooltip } from '../components/FormField';
import {
  listFiles,
  getFileColumns,
  compareEmployeeData,
  getReconciliationRun,
  applyReconciliationAction,
  exportApprovedReconciliationUpdates,
  downloadCsv,
} from '../services/api';

const PAYROLL_FIELD_CATALOG = [
  { label: 'Name', aliases: ['name', 'employee name', 'fullname', 'full name'], type: 'text' },
  { label: 'Branch', aliases: ['branch', 'location', 'office'], type: 'text' },
  { label: 'Annual Salary', aliases: ['annual salary', 'annualsalary'], type: 'currency' },
  { label: 'Basic Salary', aliases: ['basic salary', 'basicsalary', 'basic'], type: 'currency' },
  { label: 'Taxable Allowance', aliases: ['taxable allowance', 'taxableallowance'], type: 'currency' },
  { label: '5.5% SSF', aliases: ['5.5% ssf', '55 ssf', '55ssf', 'ssf 5.5', 'ssf5.5'], type: 'currency' },
  { label: '4.5% Staff PF', aliases: ['4.5% staff pf', '45staffpf', 'staff pf', 'staffpf', '45 pf'], type: 'currency' },
  { label: 'Tax Relief', aliases: ['tax relief', 'taxrelief'], type: 'currency' },
  { label: 'Taxable Salary', aliases: ['taxable salary', 'taxablesalary'], type: 'currency' },
  { label: 'Income Tax', aliases: ['income tax', 'incometax', 'paye'], type: 'currency' },
  { label: 'Other Deductions', aliases: ['other deductions', 'otherdeductions'], type: 'currency' },
  { label: 'Deductions', aliases: ['deductions', 'deduction'], type: 'currency' },
  { label: 'Total Deductions', aliases: ['total deductions', 'totaldeductions'], type: 'currency' },
  { label: 'Take Home', aliases: ['take home', 'takehome', 'net pay', 'netpay'], type: 'currency' },
  { label: '13% SSF', aliases: ['13% ssf', '13ssf'], type: 'currency' },
  { label: '11% PF', aliases: ['11% pf', '11pf'], type: 'currency' },
  { label: '1st Tier (13.5%)', aliases: ['1st tier (13.5%)', '1st tier 13.5', '1sttier135', 'first tier 13.5'], type: 'currency' },
  { label: '1st Tier (5%)', aliases: ['1st tier (5%)', '1st tier 5', '1sttier5', 'first tier 5'], type: 'currency' },
  { label: '3rd Tier (15.5%)', aliases: ['3rd tier (15.5%)', '3rd tier 15.5', '3rdtier155', 'third tier 15.5'], type: 'currency' },
];

const toneClasses = {
  blue: 'bg-blue-50 text-blue-900 border-blue-100',
  green: 'bg-emerald-50 text-emerald-900 border-emerald-100',
  amber: 'bg-amber-50 text-amber-900 border-amber-100',
  rose: 'bg-rose-50 text-rose-900 border-rose-100',
  slate: 'bg-slate-50 text-slate-900 border-slate-100',
};

function normalizeHeader(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[%()]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function canonicalHeader(value) {
  return normalizeHeader(value).replace(/\s+/g, '');
}

function scoreColumnMatch(column, aliases) {
  const normalizedColumn = normalizeHeader(column);
  const canonicalColumn = canonicalHeader(column);
  let score = 0;

  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const canonicalAlias = canonicalHeader(alias);

    if (canonicalColumn === canonicalAlias) {
      score = Math.max(score, 100);
    } else if (normalizedColumn === normalizedAlias) {
      score = Math.max(score, 95);
    } else if (canonicalColumn.includes(canonicalAlias) || canonicalAlias.includes(canonicalColumn)) {
      score = Math.max(score, 80);
    } else {
      const aliasTokens = normalizedAlias.split(' ').filter(Boolean);
      const columnTokens = normalizedColumn.split(' ').filter(Boolean);
      const matchedTokens = aliasTokens.filter((token) => columnTokens.includes(token)).length;
      if (matchedTokens > 0) {
        score = Math.max(score, matchedTokens * 20);
      }
    }
  }

  return score;
}

function findBestColumn(columns, aliases, usedColumns = new Set()) {
  let bestColumn = '';
  let bestScore = 0;

  for (const column of columns) {
    if (usedColumns.has(column)) continue;
    const score = scoreColumnMatch(column, aliases);
    if (score > bestScore) {
      bestScore = score;
      bestColumn = column;
    }
  }

  return bestScore >= 40 ? bestColumn : '';
}

function inferIdColumn(columns) {
  const preferred = [
    ['employee id', 'employeeid', 'emp id', 'empid', 'staff id', 'staffid'],
    ['id'],
  ];

  for (const aliases of preferred) {
    const found = findBestColumn(columns, aliases);
    if (found) return found;
  }
  return '';
}

function inferNameColumn(columns) {
  return findBestColumn(columns, ['name', 'employee name', 'fullname', 'full name']);
}

function inferFieldType(col1, col2, label) {
  const text = `${col1 || ''} ${col2 || ''} ${label || ''}`.toLowerCase();
  if (/salary|allowance|deduction|tax|pay|pf|ssf|tier|amount|total|home|relief|currency|bonus/.test(text)) {
    return 'currency';
  }
  return 'text';
}

function createEmptyMapping() {
  return { file1: '', file2: '', label: '', type: 'text' };
}

function inferPayrollMappings(columns1, columns2) {
  const used1 = new Set();
  const used2 = new Set();
  const mappings = [];

  for (const field of PAYROLL_FIELD_CATALOG) {
    if (field.label === 'Name') continue;
    const col1 = findBestColumn(columns1, field.aliases, used1);
    const col2 = findBestColumn(columns2, field.aliases, used2);

    if (col1 && col2) {
      used1.add(col1);
      used2.add(col2);
      mappings.push({
        file1: col1,
        file2: col2,
        label: field.label,
        type: field.type,
      });
    }
  }

  return mappings;
}

function formatNumber(value, digits = 0) {
  const num = Number(value || 0);
  return num.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

function formatCurrency(value) {
  return formatNumber(value, 2);
}

function MetricCard({ title, value, subtitle, tone = 'slate' }) {
  return (
    <div className={`rounded-xl border p-4 ${toneClasses[tone] || toneClasses.slate}`}>
      <p className="text-xs uppercase tracking-[0.08em] opacity-70">{title}</p>
      <p className="text-2xl font-semibold mt-1">{value}</p>
      {subtitle && <p className="text-xs mt-1 opacity-75">{subtitle}</p>}
    </div>
  );
}

function StackedPresenceBar({ summary }) {
  const total = Math.max(1, (summary?.matched || 0) + (summary?.only_in_file1 || 0) + (summary?.only_in_file2 || 0));
  const segments = [
    { label: 'Matched', value: summary?.matched || 0, className: 'bg-blue-500' },
    { label: 'Only File 1', value: summary?.only_in_file1 || 0, className: 'bg-amber-500' },
    { label: 'Only File 2', value: summary?.only_in_file2 || 0, className: 'bg-rose-500' },
  ];

  return (
    <div className="space-y-2">
      <div className="h-4 w-full overflow-hidden rounded-full bg-slate-100">
        <div className="flex h-full w-full">
          {segments.map((segment) => (
            <div
              key={segment.label}
              className={segment.className}
              style={{ width: `${(segment.value / total) * 100}%` }}
              title={`${segment.label}: ${segment.value}`}
            />
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs text-slate-600">
        {segments.map((segment) => (
          <div key={segment.label} className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${segment.className}`} />
            <span>{segment.label}: {formatNumber(segment.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function FieldImpactChart({ fieldSummary }) {
  const items = (fieldSummary || []).slice(0, 8);
  const maxValue = Math.max(1, ...items.map((item) => item.total_abs_difference || item.mismatch_count || 0));

  if (items.length === 0) {
    return <p className="text-sm text-slate-500">No field differences found.</p>;
  }

  return (
    <div className="space-y-3">
      {items.map((item) => {
        const value = item.total_abs_difference || item.mismatch_count || 0;
        return (
          <div key={item.field} className="grid grid-cols-[minmax(0,1fr)_96px] gap-3 items-center">
            <div>
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-sm font-medium text-slate-800 truncate">{item.field}</span>
                <span className="text-xs text-slate-500">{formatNumber(item.affected_employees)} emp.</span>
              </div>
              <div className="h-3 rounded-full bg-slate-100 overflow-hidden">
                <div
                  className="h-full rounded-full bg-gradient-to-r from-sky-500 via-cyan-500 to-emerald-500"
                  style={{ width: `${(value / maxValue) * 100}%` }}
                />
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-semibold text-slate-800">
                {item.total_abs_difference !== undefined ? formatCurrency(item.total_abs_difference) : formatNumber(item.mismatch_count)}
              </div>
              <div className="text-[11px] text-slate-500">
                {formatNumber(item.mismatch_count)} mismatches
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function PresenceList({ title, rows, tone }) {
  return (
    <div className={`rounded-xl border p-4 ${toneClasses[tone] || toneClasses.slate}`}>
      <h3 className="text-sm font-semibold mb-3">{title}</h3>
      {!rows || rows.length === 0 ? (
        <p className="text-sm opacity-75">None</p>
      ) : (
        <div className="space-y-2 max-h-64 overflow-y-auto">
          {rows.map((row, index) => (
            <div key={`${row.employee_id}-${index}`} className="rounded-lg bg-white/70 px-3 py-2 border border-white/60">
              <div className="text-sm font-medium text-slate-900">{row.employee_id}</div>
              {row.employee_name && <div className="text-xs text-slate-500">{row.employee_name}</div>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AIAuditPanel({ audit }) {
  if (!audit) return null;

  const riskTone = {
    low: 'badge-green',
    medium: 'badge-yellow',
    high: 'badge-red',
  }[String(audit.risk_level || '').toLowerCase()] || 'badge-gray';

  return (
    <div className="card p-4 space-y-4">
      <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
        <div>
          <h2 className="text-sm font-medium text-slate-900">Local AI Inconsistency Report</h2>
          <p className="text-xs text-slate-500 mt-1">
            {audit.available ? `Generated with ${audit.model}` : `AI unavailable for ${audit.model}`}
          </p>
        </div>
        <span className={`badge ${riskTone}`}>Risk: {audit.risk_level || 'unknown'}</span>
      </div>

      {audit.warning && (
        <div className="rounded-md border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
          {audit.warning}
        </div>
      )}

      {audit.executive_summary && (
        <p className="text-sm text-slate-700 leading-6">{audit.executive_summary}</p>
      )}

      {audit.key_findings?.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {audit.key_findings.map((finding, index) => (
            <div key={`${finding.category}-${index}`} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-semibold uppercase text-slate-600">{finding.category || 'finding'}</span>
                <span className="badge badge-gray">{finding.severity || 'review'}</span>
              </div>
              <p className="text-sm text-slate-900 mt-2">{finding.finding}</p>
              {finding.evidence && <p className="text-xs text-slate-500 mt-2">{finding.evidence}</p>}
            </div>
          ))}
        </div>
      )}

      {audit.recommended_actions?.length > 0 && (
        <div>
          <h3 className="text-xs font-semibold uppercase text-slate-600 mb-2">Recommended Actions</h3>
          <ul className="space-y-1">
            {audit.recommended_actions.map((action, index) => (
              <li key={`${action}-${index}`} className="text-sm text-slate-700">- {action}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function MatchingColumnsNotice({ matching }) {
  if (!matching) return null;

  const message = matching.auto_selected
    ? `Matched employees using ${matching.id_col1} and ${matching.id_col2} because the selected columns ${matching.requested_id_col1} and ${matching.requested_id_col2} did not produce the best overlap.`
    : `Matched employees using ${matching.id_col1} and ${matching.id_col2}.`;

  return (
    <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-blue-900">
      <div className="font-medium">{message}</div>
      <div className="text-xs text-blue-800 mt-1">
        Overlap: {formatNumber(matching.overlap || 0)} employees; valid IDs: File 1 {formatNumber(matching.valid_ids_file1 || 0)}, File 2 {formatNumber(matching.valid_ids_file2 || 0)}.
      </div>
    </div>
  );
}

function NameColumnsNotice({ names }) {
  if (!names?.file1 && !names?.file2) return null;

  return (
    <div className="rounded-lg border border-emerald-100 bg-emerald-50 p-3 text-sm text-emerald-900">
      <div className="font-medium">
        {names.file1 && names.file2
          ? `Name comparison uses ${names.file1} (File 1) and ${names.file2} (File 2).`
          : 'Name columns were not selected, so name mismatches are not included in this audit.'}
      </div>
      {names.file1 && names.file2 && (
        <div className="text-xs text-emerald-800 mt-1">
          Names are compared as normalized tokens, so reordered names and middle-name additions are not treated as automatic mismatches.
        </div>
      )}
    </div>
  );
}

export default function Comparison() {
  const [files, setFiles] = useState([]);
  const [file1, setFile1] = useState('');
  const [file2, setFile2] = useState('');
  const [file1Columns, setFile1Columns] = useState([]);
  const [file2Columns, setFile2Columns] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [errorDetails, setErrorDetails] = useState(null);
  const [reconciliationRun, setReconciliationRun] = useState(null);
  const [reconciliationActionId, setReconciliationActionId] = useState('');
  const [reconciliationExport, setReconciliationExport] = useState(null);
  const [exportingReconciliation, setExportingReconciliation] = useState(false);

  const [salaryOptions, setSalaryOptions] = useState({
    idCol1: '',
    idCol2: '',
    normalizeIds: true,
  });
  const [dataOptions, setDataOptions] = useState({
    nameCol1: '',
    nameCol2: '',
    keepDigits: 5,
    tolerance: 0.01,
    mappings: [],
  });

  const mappingFilePair = useRef('');

  function clearErrorDetails() {
    setErrorDetails(null);
  }

  function buildRequestContext() {
    return {
      request_type: 'employee-data',
      file1_id: file1,
      file2_id: file2,
      id_col1: salaryOptions.idCol1,
      id_col2: salaryOptions.idCol2,
      name_col1: dataOptions.nameCol1 || null,
      name_col2: dataOptions.nameCol2 || null,
      normalize_ids: salaryOptions.normalizeIds,
      keep_digits: Number(dataOptions.keepDigits) || 5,
      tolerance: Number(dataOptions.tolerance) || 0.01,
      mapped_fields_count: activeMappings.length,
      mapped_fields: activeMappings.map((m) => m.label || `${m.file1} / ${m.file2}`),
    };
  }

  function captureError(error) {
    const detail = error?.response?.data?.detail;
    let message = 'Unexpected error while processing request';
    let backendCode = error?.response?.status || null;

    if (typeof detail === 'string' && detail.trim()) {
      message = detail;
    } else if (Array.isArray(detail)) {
      message = detail
        .map((item) => item?.msg || JSON.stringify(item))
        .join('; ');
    } else if (detail && typeof detail === 'object') {
      message = detail.message || JSON.stringify(detail);
    } else if (error?.message) {
      message = error.message;
    }

    setErrorDetails({
      title: 'Failed payroll audit request',
      message,
      backend_code: backendCode,
      timestamp: new Date().toISOString(),
      request_context: buildRequestContext(),
    });
  }

  const activeMappings = useMemo(
    () => dataOptions.mappings.filter((mapping) => mapping.file1 && mapping.file2),
    [dataOptions.mappings]
  );

  useEffect(() => {
    loadFiles();
  }, []);

  useEffect(() => {
    if (file1) {
      loadFileColumns(file1, setFile1Columns);
      setSalaryOptions((prev) => ({ ...prev, idCol1: '' }));
      setDataOptions((prev) => ({ ...prev, nameCol1: '' }));
    } else {
      setFile1Columns([]);
    }
  }, [file1]);

  useEffect(() => {
    if (file2) {
      loadFileColumns(file2, setFile2Columns);
      setSalaryOptions((prev) => ({ ...prev, idCol2: '' }));
      setDataOptions((prev) => ({ ...prev, nameCol2: '' }));
    } else {
      setFile2Columns([]);
    }
  }, [file2]);

  useEffect(() => {
    if (file1Columns.length === 0) return;

    setSalaryOptions((prev) => ({
      ...prev,
      idCol1: prev.idCol1 || inferIdColumn(file1Columns),
    }));
    setDataOptions((prev) => ({
      ...prev,
      nameCol1: prev.nameCol1 || inferNameColumn(file1Columns),
    }));
  }, [file1Columns]);

  useEffect(() => {
    if (file2Columns.length === 0) return;

    setSalaryOptions((prev) => ({
      ...prev,
      idCol2: prev.idCol2 || inferIdColumn(file2Columns),
    }));
    setDataOptions((prev) => ({
      ...prev,
      nameCol2: prev.nameCol2 || inferNameColumn(file2Columns),
    }));
  }, [file2Columns]);

  useEffect(() => {
    if (file1Columns.length === 0 || file2Columns.length === 0) return;

    const pairKey = `${file1}|${file2}`;
    if (mappingFilePair.current === pairKey) return;
    mappingFilePair.current = pairKey;

    const inferredMappings = inferPayrollMappings(file1Columns, file2Columns);
    setDataOptions((prev) => ({
      ...prev,
      mappings: inferredMappings.length > 0 ? inferredMappings : [createEmptyMapping()],
    }));
    setResult(null);
    setReconciliationRun(null);
  }, [file1, file2, file1Columns, file2Columns]);

  function addColumnMapping() {
    setDataOptions((prev) => ({
      ...prev,
      mappings: [...prev.mappings, createEmptyMapping()],
    }));
  }

  function removeColumnMapping(index) {
    setDataOptions((prev) => ({
      ...prev,
      mappings: prev.mappings.filter((_, mappingIndex) => mappingIndex !== index),
    }));
  }

  function updateColumnMapping(index, field, value) {
    setDataOptions((prev) => {
      const mappings = prev.mappings.map((mapping, mappingIndex) => {
        if (mappingIndex !== index) return mapping;
        const next = { ...mapping, [field]: value };
        if ((field === 'file1' || field === 'file2') && !next.label) {
          const col1 = field === 'file1' ? value : next.file1;
          const col2 = field === 'file2' ? value : next.file2;
          if (col1 && col2) {
            next.label = col1 === col2 ? col1 : `${col1} / ${col2}`;
          }
        }
        if (field === 'file1' || field === 'file2' || field === 'label') {
          next.type = inferFieldType(next.file1, next.file2, next.label);
        }
        return next;
      });
      return { ...prev, mappings };
    });
  }

  async function loadFiles() {
    try {
      const data = await listFiles();
      setFiles(data.files || []);
    } catch {
      toast.error('Failed to load files');
    }
  }

  async function loadFileColumns(fileId, setColumns) {
    try {
      const data = await getFileColumns(fileId);
      setColumns(data.columns || []);
    } catch {
      toast.error('Failed to load columns');
    }
  }

  async function handleEmployeeDataComparison() {
    if (!file1 || !file2 || !salaryOptions.idCol1 || !salaryOptions.idCol2) {
      toast.error('Select both files and employee ID columns');
      return;
    }
    if (activeMappings.length === 0) {
      toast.error('Add at least one column pair to compare');
      return;
    }

    setLoading(true);
    clearErrorDetails();
    try {
      const data = await compareEmployeeData({
        file1_id: file1,
        file2_id: file2,
        id_col1: salaryOptions.idCol1,
        id_col2: salaryOptions.idCol2,
        column_mappings: activeMappings,
        name_col1: dataOptions.nameCol1 || null,
        name_col2: dataOptions.nameCol2 || null,
        normalize_ids: salaryOptions.normalizeIds,
        keep_digits: Number(dataOptions.keepDigits) || 5,
        tolerance: Number(dataOptions.tolerance) || 0.01,
        use_ai: true,
      });
      setResult({ type: 'employee-data', ...data });
      setReconciliationExport(null);
      if (data.reconciliation_run?.id) {
        await refreshReconciliationRun(data.reconciliation_run.id);
      } else {
        setReconciliationRun(null);
      }
      if (data.reconciliation_warning) {
        toast.error(`Audit completed, but review setup failed: ${data.reconciliation_warning}`);
      }
      clearErrorDetails();
      toast.success('Payroll audit completed');
    } catch (error) {
      captureError(error);
      toast.error(error.response?.data?.detail || 'Employee data audit failed');
    } finally {
      setLoading(false);
    }
  }

  function handleDownloadResult(fileId) {
    window.open(downloadCsv(fileId), '_blank');
  }

  async function refreshReconciliationRun(runId) {
    try {
      const run = await getReconciliationRun(runId);
      setReconciliationRun(run);
      return run;
    } catch {
      toast.error('Failed to load reconciliation review');
      return null;
    }
  }

  async function handleReconciliationAction(issueId, action) {
    const runId = reconciliationRun?.id;
    if (!runId) return;
    setReconciliationActionId(issueId);
    try {
      const run = await applyReconciliationAction(runId, issueId, action);
      setReconciliationRun(run);
      setReconciliationExport(null);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to update issue');
    } finally {
      setReconciliationActionId('');
    }
  }

  async function handleExportApprovedUpdates() {
    const runId = reconciliationRun?.id;
    if (!runId) return;
    setExportingReconciliation(true);
    try {
      const data = await exportApprovedReconciliationUpdates(runId);
      setReconciliationExport(data);
      toast.success(`Generated ${Object.keys(data.files || {}).length} update file(s)`);
    } catch (error) {
      toast.error(error.response?.data?.detail || 'Failed to export approved updates');
    } finally {
      setExportingReconciliation(false);
    }
  }

  const selectedFileNames = useMemo(() => {
    const fileA = files.find((file) => file.id === file1)?.filename;
    const fileB = files.find((file) => file.id === file2)?.filename;
    return { fileA, fileB };
  }, [files, file1, file2]);

  const visibleReconciliationIssues = useMemo(
    () => (reconciliationRun?.issues || []).slice(0, 40),
    [reconciliationRun]
  );

  const approvedIssueCount = reconciliationRun?.status_counts?.approved || 0;

  return (
    <div className="space-y-4">
      <div className="card p-4 space-y-4">
        <div>
          <h2 className="text-sm font-medium text-slate-900">Payroll Audit</h2>
          <p className="text-xs text-slate-500 mt-1">
            Select two files, choose how employees are matched, pick column pairs to compare, then click Start Auditing.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <h3 className="text-xs font-medium text-slate-600">File 1</h3>
            <FormField label="Payroll file" tooltip="The first payroll export to compare against File 2.">
              <select
                value={file1}
                onChange={(e) => {
                  setFile1(e.target.value);
                  setResult(null);
                  mappingFilePair.current = '';
                }}
                className="input"
              >
                <option value="">Select file...</option>
                {files.map((file) => (
                  <option key={file.id} value={file.id}>{file.filename}</option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Employee ID column"
              tooltip="Used to match the same employee across both files. Pick the column that uniquely identifies each person in this file."
            >
              <select value={salaryOptions.idCol1} onChange={(e) => setSalaryOptions((prev) => ({ ...prev, idCol1: e.target.value }))} className="input">
                <option value="">Select employee ID column...</option>
                {file1Columns.map((col) => <option key={col} value={col}>{col}</option>)}
              </select>
            </FormField>
            <FormField
              label="Name column"
              tooltip="Optional. When selected, employee names are compared and shown in audit results. Leave blank if you only want numeric or other field comparisons."
            >
              <select value={dataOptions.nameCol1} onChange={(e) => setDataOptions((prev) => ({ ...prev, nameCol1: e.target.value }))} className="input">
                <option value="">No name column</option>
                {file1Columns.map((col) => <option key={col} value={col}>{col}</option>)}
              </select>
            </FormField>
          </div>

          <div className="space-y-2">
            <h3 className="text-xs font-medium text-slate-600">File 2</h3>
            <FormField label="Payroll file" tooltip="The second payroll export to compare against File 1.">
              <select
                value={file2}
                onChange={(e) => {
                  setFile2(e.target.value);
                  setResult(null);
                  mappingFilePair.current = '';
                }}
                className="input"
              >
                <option value="">Select file...</option>
                {files.map((file) => (
                  <option key={file.id} value={file.id}>{file.filename}</option>
                ))}
              </select>
            </FormField>
            <FormField
              label="Employee ID column"
              tooltip="Must correspond to the same employees as File 1. Rows are matched using these two ID columns."
            >
              <select value={salaryOptions.idCol2} onChange={(e) => setSalaryOptions((prev) => ({ ...prev, idCol2: e.target.value }))} className="input">
                <option value="">Select employee ID column...</option>
                {file2Columns.map((col) => <option key={col} value={col}>{col}</option>)}
              </select>
            </FormField>
            <FormField
              label="Name column"
              tooltip="Optional. Paired with the File 1 name column for name mismatch checks in the audit results."
            >
              <select value={dataOptions.nameCol2} onChange={(e) => setDataOptions((prev) => ({ ...prev, nameCol2: e.target.value }))} className="input">
                <option value="">No name column</option>
                {file2Columns.map((col) => <option key={col} value={col}>{col}</option>)}
              </select>
            </FormField>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <label className="flex items-center gap-1.5 text-sm">
            <input
              type="checkbox"
              checked={salaryOptions.normalizeIds}
              onChange={(e) => setSalaryOptions((prev) => ({ ...prev, normalizeIds: e.target.checked }))}
              className="rounded border-slate-300"
            />
            <span className="text-slate-800 font-medium">Normalize IDs</span>
            <FieldTooltip
              label="Normalize IDs"
              text="Strips formatting from ID values before matching, so values like EMP-00123 and 123 can still match."
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-slate-800">
            <span className="font-medium">ID digits to keep</span>
            <FieldTooltip
              label="ID digits to keep"
              text="When normalizing IDs, only the last N digits are kept for matching. Use this when one file has longer ID formats than the other."
            />
            <input
              type="number"
              min="1"
              max="12"
              value={dataOptions.keepDigits}
              onChange={(e) => setDataOptions((prev) => ({ ...prev, keepDigits: e.target.value }))}
              className="input w-20"
            />
          </label>
          <label className="flex items-center gap-1.5 text-sm text-slate-800">
            <span className="font-medium">Numeric tolerance</span>
            <FieldTooltip
              label="Numeric tolerance"
              text="Small differences in currency or numeric columns below this amount are treated as equal and not flagged."
            />
            <input
              type="number"
              min="0"
              step="0.01"
              value={dataOptions.tolerance}
              onChange={(e) => setDataOptions((prev) => ({ ...prev, tolerance: e.target.value }))}
              className="input w-24"
            />
          </label>
        </div>

        <div className="space-y-3">
          <div>
            <h3 className="text-sm font-medium text-slate-900">Column Comparisons</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Choose a column from each file to compare. Suggested payroll fields are pre-filled when possible — add, remove, or change pairs before auditing.
            </p>
          </div>

          <div className="overflow-x-auto border border-slate-200 rounded-md">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Label</th>
                  <th>File 1 column</th>
                  <th>File 2 column</th>
                  <th className="w-16" />
                </tr>
              </thead>
              <tbody>
                {dataOptions.mappings.map((mapping, index) => (
                  <tr key={`mapping-${index}`}>
                    <td>
                      <input
                        type="text"
                        value={mapping.label}
                        onChange={(e) => updateColumnMapping(index, 'label', e.target.value)}
                        placeholder="Comparison label"
                        className="input text-xs"
                      />
                    </td>
                    <td>
                      <select
                        value={mapping.file1}
                        onChange={(e) => updateColumnMapping(index, 'file1', e.target.value)}
                        className="input text-xs"
                      >
                        <option value="">Select column...</option>
                        {file1Columns.map((col) => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <select
                        value={mapping.file2}
                        onChange={(e) => updateColumnMapping(index, 'file2', e.target.value)}
                        className="input text-xs"
                      >
                        <option value="">Select column...</option>
                        {file2Columns.map((col) => (
                          <option key={col} value={col}>{col}</option>
                        ))}
                      </select>
                    </td>
                    <td>
                      <button
                        type="button"
                        onClick={() => removeColumnMapping(index)}
                        disabled={dataOptions.mappings.length <= 1}
                        className="btn btn-secondary text-xs px-2 py-1 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <button type="button" onClick={addColumnMapping} className="btn btn-secondary text-xs">
              Add column pair
            </button>
            <button
              onClick={handleEmployeeDataComparison}
              disabled={loading || !file1 || !file2 || !salaryOptions.idCol1 || !salaryOptions.idCol2 || activeMappings.length === 0}
              className="btn btn-primary"
            >
              {loading ? 'Auditing...' : 'Start Auditing'}
            </button>
          </div>
        </div>
      </div>

      {errorDetails && (
        <div className="card p-4 border border-rose-200 bg-rose-50/60 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-rose-800">{errorDetails.title}</h2>
              <p className="text-sm text-rose-700 mt-1">{errorDetails.message}</p>
              <p className="text-xs text-rose-600 mt-1">
                {errorDetails.backend_code ? `HTTP ${errorDetails.backend_code}` : 'No HTTP status available'}
                {' '}•{' '}
                {new Date(errorDetails.timestamp).toLocaleString()}
              </p>
            </div>
            <button onClick={clearErrorDetails} className="btn btn-secondary text-xs">Dismiss</button>
          </div>

          <details className="rounded-md border border-rose-200 bg-white p-3">
            <summary className="text-xs font-medium text-rose-700 cursor-pointer">Request context</summary>
            <pre className="mt-2 text-[11px] leading-5 text-slate-700 whitespace-pre-wrap break-words">
{JSON.stringify(errorDetails.request_context, null, 2)}
            </pre>
          </details>
        </div>
      )}

      {result?.type === 'employee-data' && result.summary && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <MetricCard title="Matched Employees" value={formatNumber(result.summary.matched)} subtitle={`${selectedFileNames.fileA || 'File 1'} vs ${selectedFileNames.fileB || 'File 2'}`} tone="blue" />
            <MetricCard title="Employees With Differences" value={formatNumber(result.summary.employees_with_differences)} subtitle={`${formatNumber(result.summary.field_differences)} field-level mismatches`} tone="amber" />
            <MetricCard title="Only In File 1" value={formatNumber(result.summary.only_in_file1)} subtitle="Employees missing from File 2" tone="rose" />
            <MetricCard title="Only In File 2" value={formatNumber(result.summary.only_in_file2)} subtitle="Employees missing from File 1" tone="green" />
          </div>

          <AIAuditPanel audit={result.ai_audit} />

          <MatchingColumnsNotice matching={result.matching_columns} />

          <NameColumnsNotice names={result.name_columns} />

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="card p-4 xl:col-span-2 space-y-3">
              <div>
                <h2 className="text-sm font-medium text-slate-900">Coverage Across Both Files</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Shared employees versus records found in only one payroll file.
                </p>
              </div>
              <StackedPresenceBar summary={result.summary} />
            </div>

            <div className="card p-4 space-y-3">
              <div>
                <h2 className="text-sm font-medium text-slate-900">Payroll Impact</h2>
                <p className="text-xs text-slate-500 mt-1">Largest variance across numeric payroll fields.</p>
              </div>
              <MetricCard
                title="Total Absolute Variance"
                value={formatCurrency(result.analytics?.total_abs_difference || 0)}
                subtitle={`${formatNumber(result.analytics?.numeric_fields_compared || 0)} numeric fields compared`}
                tone="slate"
              />
              {result.analytics?.largest_variance_field && (
                <div className="rounded-xl border border-slate-200 p-4 bg-slate-50">
                  <div className="text-xs text-slate-500 uppercase tracking-[0.08em]">Largest variance field</div>
                  <div className="text-lg font-semibold text-slate-900 mt-1">{result.analytics.largest_variance_field.field}</div>
                  <div className="text-sm text-slate-600 mt-1">
                    {formatCurrency(result.analytics.largest_variance_field.total_abs_difference || 0)} total variance
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    {formatNumber(result.analytics.largest_variance_field.affected_employees || 0)} employees affected
                  </div>
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
            <div className="card p-4 xl:col-span-2 space-y-3">
              <div>
                <h2 className="text-sm font-medium text-slate-900">Difference Concentration By Payroll Field</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Fields with the largest difference volume are shown first.
                </p>
              </div>
              <FieldImpactChart fieldSummary={result.analytics?.field_summary} />
            </div>

            <div className="space-y-4">
              <PresenceList title="Employees Only In File 1" rows={result.presence_preview?.only_in_file1} tone="amber" />
              <PresenceList title="Employees Only In File 2" rows={result.presence_preview?.only_in_file2} tone="green" />
            </div>
          </div>

          {(result.duplicate_id_samples?.file1?.length > 0 || result.duplicate_id_samples?.file2?.length > 0) && (
            <div className="card p-4 space-y-2">
              <h2 className="text-sm font-medium text-slate-900">Duplicate ID Samples</h2>
              {result.duplicate_id_samples.file1?.length > 0 && (
                <p className="text-xs text-slate-600">File 1: {result.duplicate_id_samples.file1.join(', ')}</p>
              )}
              {result.duplicate_id_samples.file2?.length > 0 && (
                <p className="text-xs text-slate-600">File 2: {result.duplicate_id_samples.file2.join(', ')}</p>
              )}
            </div>
          )}

          {result.files_created && Object.keys(result.files_created).length > 0 && (
            <div className="card p-4 space-y-2">
              <h2 className="text-sm font-medium text-slate-900">Download Audit Files</h2>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(result.files_created).map(([name, id]) => (
                  <button key={name} onClick={() => handleDownloadResult(typeof id === 'object' ? id.file_id : id)} className="btn btn-secondary text-xs">
                    {name}
                  </button>
                ))}
              </div>
            </div>
          )}

          {reconciliationRun && (
            <div className="card p-4 space-y-4">
              <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                <div>
                  <h2 className="text-sm font-medium text-slate-900">Reconciliation Review Workbench</h2>
                  <p className="text-xs text-slate-500 mt-1">
                    Approve valid HR changes, reject incorrect differences, or ignore items that do not need action.
                  </p>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(reconciliationRun.status_counts || {}).map(([status, count]) => (
                    <span key={status} className="badge badge-gray">{status}: {formatNumber(count)}</span>
                  ))}
                  <button
                    onClick={handleExportApprovedUpdates}
                    disabled={exportingReconciliation || approvedIssueCount === 0}
                    className="btn btn-primary text-xs disabled:opacity-40"
                  >
                    {exportingReconciliation ? 'Exporting...' : 'Export Approved HR Updates'}
                  </button>
                </div>
              </div>

              {reconciliationExport?.files && Object.keys(reconciliationExport.files).length > 0 && (
                <div className="rounded-md border border-emerald-100 bg-emerald-50 p-3">
                  <div className="text-xs font-medium text-emerald-900 mb-2">Generated HR update files</div>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(reconciliationExport.files).map(([name, meta]) => (
                      <button key={name} onClick={() => handleDownloadResult(meta.file_id)} className="btn btn-secondary text-xs">
                        {name} ({formatNumber(meta.records)})
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div className="overflow-hidden border rounded-md">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Status</th>
                      <th>Issue</th>
                      <th>Employee</th>
                      <th>Field</th>
                      <th>Old</th>
                      <th>New</th>
                      <th>Reason</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleReconciliationIssues.map((issue) => (
                      <tr key={issue.id}>
                        <td>
                          <span className={issue.status === 'approved' ? 'badge badge-green' : issue.status === 'open' ? 'badge badge-blue' : 'badge badge-gray'}>
                            {issue.status}
                          </span>
                        </td>
                        <td>
                          <div className="font-medium text-slate-800">{issue.issue_type.replaceAll('_', ' ')}</div>
                          <div className="text-[11px] text-slate-500">{Math.round((issue.confidence || 0) * 100)}% confidence</div>
                        </td>
                        <td>
                          <div className="text-xs font-medium">{issue.employee_id || '-'}</div>
                          {issue.employee_name && <div className="text-[11px] text-slate-500">{issue.employee_name}</div>}
                        </td>
                        <td>{issue.field || '-'}</td>
                        <td>{issue.old_value ?? '-'}</td>
                        <td>{issue.new_value ?? '-'}</td>
                        <td>
                          <div className="max-w-xs text-xs text-slate-600">{issue.explanation}</div>
                          <div className="text-[11px] text-slate-400 mt-1">{issue.suggested_action}</div>
                        </td>
                        <td>
                          <div className="flex flex-wrap gap-1">
                            {issue.status !== 'approved' && (
                              <button
                                onClick={() => handleReconciliationAction(issue.id, 'approve')}
                                disabled={reconciliationActionId === issue.id}
                                className="btn btn-secondary text-[11px] px-2 py-1"
                              >
                                Approve
                              </button>
                            )}
                            {issue.status !== 'rejected' && (
                              <button
                                onClick={() => handleReconciliationAction(issue.id, 'reject')}
                                disabled={reconciliationActionId === issue.id}
                                className="btn btn-secondary text-[11px] px-2 py-1"
                              >
                                Reject
                              </button>
                            )}
                            {issue.status !== 'ignored' && (
                              <button
                                onClick={() => handleReconciliationAction(issue.id, 'ignore')}
                                disabled={reconciliationActionId === issue.id}
                                className="btn btn-secondary text-[11px] px-2 py-1"
                              >
                                Ignore
                              </button>
                            )}
                            {issue.status !== 'open' && (
                              <button
                                onClick={() => handleReconciliationAction(issue.id, 'reopen')}
                                disabled={reconciliationActionId === issue.id}
                                className="btn btn-secondary text-[11px] px-2 py-1"
                              >
                                Reopen
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {visibleReconciliationIssues.length === 0 && (
                      <tr>
                        <td colSpan={8}>No reconciliation issues were generated.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {(reconciliationRun.issues || []).length > visibleReconciliationIssues.length && (
                <p className="text-xs text-slate-500">
                  Showing {formatNumber(visibleReconciliationIssues.length)} of {formatNumber(reconciliationRun.issues.length)} issues.
                </p>
              )}
            </div>
          )}

          <div className="card p-4">
            <div className="flex items-center justify-between gap-4 mb-3">
              <div>
                <h2 className="text-sm font-medium text-slate-900">Preview of Payroll Differences</h2>
                <p className="text-xs text-slate-500 mt-1">Top mismatches from your selected column pairs.</p>
              </div>
              <span className="badge badge-gray">{formatNumber(result.preview_differences?.length || 0)} preview rows</span>
            </div>
            <DataTable data={result.preview_differences || []} />
          </div>
        </div>
      )}
    </div>
  );
}
