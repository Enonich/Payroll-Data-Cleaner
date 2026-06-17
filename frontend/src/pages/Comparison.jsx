import { useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import DataTable from '../components/DataTable';
import {
  listFiles,
  getFileColumns,
  compareSalaries,
  compareEmployeePresence,
  compareEmployeeData,
  generateAllowanceFiles,
  identifyColumns,
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

function inferPayrollMappings(columns1, columns2) {
  const used1 = new Set();
  const used2 = new Set();
  const mappings = [];

  for (const field of PAYROLL_FIELD_CATALOG) {
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

export default function Comparison() {
  const [files, setFiles] = useState([]);
  const [file1, setFile1] = useState('');
  const [file2, setFile2] = useState('');
  const [file1Columns, setFile1Columns] = useState([]);
  const [file2Columns, setFile2Columns] = useState([]);
  const [comparisonType, setComparisonType] = useState('employee-data');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [errorDetails, setErrorDetails] = useState(null);

  const [salaryOptions, setSalaryOptions] = useState({
    idCol1: '',
    idCol2: '',
    salaryCol1: '',
    salaryCol2: '',
    normalizeIds: true,
  });
  const [dataOptions, setDataOptions] = useState({
    nameCol1: '',
    nameCol2: '',
    keepDigits: 5,
    tolerance: 0.01,
    mappings: [],
  });
  const [allowanceOptions, setAllowanceOptions] = useState({
    fileId: '',
    staffIdColumn: '',
    valueColumns: [],
    templateType: 'allowance',
  });

  const autoAuditSignature = useRef('');

  function clearErrorDetails() {
    setErrorDetails(null);
  }

  function buildRequestContext(requestType) {
    if (requestType === 'employee-data') {
      return {
        request_type: requestType,
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
        mapped_fields: activeMappings.map((m) => m.label),
      };
    }

    if (requestType === 'salary') {
      return {
        request_type: requestType,
        file1_id: file1,
        file2_id: file2,
        id_col1: salaryOptions.idCol1,
        id_col2: salaryOptions.idCol2,
        salary_col1: salaryOptions.salaryCol1,
        salary_col2: salaryOptions.salaryCol2,
        normalize_ids: salaryOptions.normalizeIds,
      };
    }

    if (requestType === 'presence') {
      return {
        request_type: requestType,
        file1_id: file1,
        file2_id: file2,
        id_col1: salaryOptions.idCol1,
        id_col2: salaryOptions.idCol2,
        normalize_ids: salaryOptions.normalizeIds,
      };
    }

    if (requestType === 'allowance') {
      return {
        request_type: requestType,
        file_id: allowanceOptions.fileId,
        staff_id_column: allowanceOptions.staffIdColumn,
        template_type: allowanceOptions.templateType,
        value_columns_count: allowanceOptions.valueColumns.length,
      };
    }

    return { request_type: requestType };
  }

  function captureError(requestType, error) {
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
      title: `Failed ${requestType} request`,
      message,
      backend_code: backendCode,
      timestamp: new Date().toISOString(),
      request_context: buildRequestContext(requestType),
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
    } else {
      setFile1Columns([]);
    }
  }, [file1]);

  useEffect(() => {
    if (file2) {
      loadFileColumns(file2, setFile2Columns);
    } else {
      setFile2Columns([]);
    }
  }, [file2]);

  useEffect(() => {
    if (file1Columns.length === 0) return;

    setSalaryOptions((prev) => ({
      ...prev,
      idCol1: prev.idCol1 || inferIdColumn(file1Columns),
      salaryCol1: prev.salaryCol1 || findBestColumn(file1Columns, ['take home', 'takehome', 'net pay', 'netpay', 'basic salary', 'basicsalary']),
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
      salaryCol2: prev.salaryCol2 || findBestColumn(file2Columns, ['take home', 'takehome', 'net pay', 'netpay', 'basic salary', 'basicsalary']),
    }));
    setDataOptions((prev) => ({
      ...prev,
      nameCol2: prev.nameCol2 || inferNameColumn(file2Columns),
    }));
  }, [file2Columns]);

  useEffect(() => {
    if (file1Columns.length === 0 || file2Columns.length === 0) return;

    const inferredMappings = inferPayrollMappings(file1Columns, file2Columns);
    setDataOptions((prev) => {
      const currentKey = JSON.stringify(prev.mappings);
      const nextKey = JSON.stringify(inferredMappings);
      if (currentKey === nextKey) return prev;
      return {
        ...prev,
        mappings: inferredMappings,
      };
    });
  }, [file1Columns, file2Columns]);

  useEffect(() => {
    if (comparisonType !== 'employee-data') return;
    if (!file1 || !file2 || !salaryOptions.idCol1 || !salaryOptions.idCol2) return;
    if (activeMappings.length === 0) return;

    const signature = JSON.stringify({
      file1,
      file2,
      id1: salaryOptions.idCol1,
      id2: salaryOptions.idCol2,
      name1: dataOptions.nameCol1,
      name2: dataOptions.nameCol2,
      normalizeIds: salaryOptions.normalizeIds,
      keepDigits: dataOptions.keepDigits,
      tolerance: dataOptions.tolerance,
      mappings: activeMappings,
    });

    if (autoAuditSignature.current === signature) return;
    autoAuditSignature.current = signature;
    handleEmployeeDataComparison(true);
  }, [comparisonType, file1, file2, salaryOptions.idCol1, salaryOptions.idCol2, salaryOptions.normalizeIds, dataOptions.nameCol1, dataOptions.nameCol2, dataOptions.keepDigits, dataOptions.tolerance, activeMappings]);

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

  async function handleSalaryComparison() {
    if (!file1 || !file2 || !salaryOptions.idCol1 || !salaryOptions.idCol2 || !salaryOptions.salaryCol1 || !salaryOptions.salaryCol2) {
      toast.error('Select both files, ID columns, and salary columns');
      return;
    }

    setLoading(true);
    clearErrorDetails();
    try {
      const data = await compareSalaries({
        file1_id: file1,
        file2_id: file2,
        id_col1: salaryOptions.idCol1,
        id_col2: salaryOptions.idCol2,
        salary_col1: salaryOptions.salaryCol1,
        salary_col2: salaryOptions.salaryCol2,
        normalize_ids: salaryOptions.normalizeIds,
      });
      setResult({ type: 'salary', ...data });
      toast.success('Salary comparison completed');
    } catch (error) {
      captureError('salary', error);
      toast.error(error.response?.data?.detail || 'Comparison failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleEmployeeComparison() {
    if (!file1 || !file2 || !salaryOptions.idCol1 || !salaryOptions.idCol2) {
      toast.error('Select both files and ID columns');
      return;
    }

    setLoading(true);
    clearErrorDetails();
    try {
      const data = await compareEmployeePresence({
        file1_id: file1,
        file2_id: file2,
        id_col1: salaryOptions.idCol1,
        id_col2: salaryOptions.idCol2,
        normalize_ids: salaryOptions.normalizeIds,
      });
      setResult({ type: 'presence', ...data });
      toast.success('Presence comparison completed');
    } catch (error) {
      captureError('presence', error);
      toast.error(error.response?.data?.detail || 'Comparison failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleEmployeeDataComparison(silent = false) {
    if (!file1 || !file2 || !salaryOptions.idCol1 || !salaryOptions.idCol2) {
      if (!silent) toast.error('Select both files and ID columns');
      return;
    }
    if (activeMappings.length === 0) {
      if (!silent) toast.error('No payroll fields were matched across the files');
      return;
    }

    setLoading(true);
    if (!silent) clearErrorDetails();
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
      });
      setResult({ type: 'employee-data', ...data });
      clearErrorDetails();
      if (!silent) {
        toast.success('Payroll audit completed');
      }
    } catch (error) {
      captureError('employee-data', error);
      if (!silent) {
        toast.error(error.response?.data?.detail || 'Employee data audit failed');
      }
    } finally {
      setLoading(false);
    }
  }

  async function handleGenerateAllowances() {
    if (!allowanceOptions.fileId || !allowanceOptions.staffIdColumn) {
      toast.error('Please select file and staff ID column');
      return;
    }

    setLoading(true);
    clearErrorDetails();
    try {
      const data = await generateAllowanceFiles({
        file_id: allowanceOptions.fileId,
        staff_id_column: allowanceOptions.staffIdColumn,
        value_columns: allowanceOptions.valueColumns,
        template_type: allowanceOptions.templateType,
      });
      setResult({ type: 'allowance', ...data });
      toast.success(`Generated ${Object.keys(data.files || {}).length} files`);
    } catch (error) {
      captureError('allowance', error);
      toast.error(error.response?.data?.detail || 'Generation failed');
    } finally {
      setLoading(false);
    }
  }

  function handleDownloadResult(fileId) {
    window.open(downloadCsv(fileId), '_blank');
  }

  const selectedFileNames = useMemo(() => {
    const fileA = files.find((file) => file.id === file1)?.filename;
    const fileB = files.find((file) => file.id === file2)?.filename;
    return { fileA, fileB };
  }, [files, file1, file2]);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">Payroll Comparison</h1>
        <p className="text-sm text-slate-500 mt-0.5">
          Load two payroll files to automatically audit salary-related columns, spot mismatches, and find employees missing from either file.
        </p>
      </div>

      <div className="card p-4 space-y-4">
        <div className="flex flex-wrap gap-2">
          {[
            ['employee-data', 'Payroll Audit'],
            ['salary', 'Single Salary Field'],
            ['presence', 'Employee Presence'],
            ['allowance', 'Allowances'],
          ].map(([value, label]) => (
            <button
              key={value}
              onClick={() => setComparisonType(value)}
              className={`px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
                comparisonType === value
                  ? 'bg-blue-600 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {(comparisonType === 'employee-data' || comparisonType === 'salary' || comparisonType === 'presence') && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-slate-600">File 1</h3>
              <select value={file1} onChange={(e) => { setFile1(e.target.value); setResult(null); autoAuditSignature.current = ''; }} className="input">
                <option value="">Select file...</option>
                {files.map((file) => (
                  <option key={file.id} value={file.id}>{file.filename}</option>
                ))}
              </select>
              <select value={salaryOptions.idCol1} onChange={(e) => setSalaryOptions((prev) => ({ ...prev, idCol1: e.target.value }))} className="input">
                <option value="">ID Column...</option>
                {file1Columns.map((col) => <option key={col} value={col}>{col}</option>)}
              </select>
              {comparisonType === 'employee-data' && (
                <select value={dataOptions.nameCol1} onChange={(e) => setDataOptions((prev) => ({ ...prev, nameCol1: e.target.value }))} className="input">
                  <option value="">Name Column...</option>
                  {file1Columns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
              )}
              {comparisonType === 'salary' && (
                <select value={salaryOptions.salaryCol1} onChange={(e) => setSalaryOptions((prev) => ({ ...prev, salaryCol1: e.target.value }))} className="input">
                  <option value="">Salary Column...</option>
                  {file1Columns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
              )}
            </div>

            <div className="space-y-2">
              <h3 className="text-xs font-medium text-slate-600">File 2</h3>
              <select value={file2} onChange={(e) => { setFile2(e.target.value); setResult(null); autoAuditSignature.current = ''; }} className="input">
                <option value="">Select file...</option>
                {files.map((file) => (
                  <option key={file.id} value={file.id}>{file.filename}</option>
                ))}
              </select>
              <select value={salaryOptions.idCol2} onChange={(e) => setSalaryOptions((prev) => ({ ...prev, idCol2: e.target.value }))} className="input">
                <option value="">ID Column...</option>
                {file2Columns.map((col) => <option key={col} value={col}>{col}</option>)}
              </select>
              {comparisonType === 'employee-data' && (
                <select value={dataOptions.nameCol2} onChange={(e) => setDataOptions((prev) => ({ ...prev, nameCol2: e.target.value }))} className="input">
                  <option value="">Name Column...</option>
                  {file2Columns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
              )}
              {comparisonType === 'salary' && (
                <select value={salaryOptions.salaryCol2} onChange={(e) => setSalaryOptions((prev) => ({ ...prev, salaryCol2: e.target.value }))} className="input">
                  <option value="">Salary Column...</option>
                  {file2Columns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
              )}
            </div>
          </div>
        )}

        {(comparisonType === 'employee-data' || comparisonType === 'salary' || comparisonType === 'presence') && (
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={salaryOptions.normalizeIds}
                onChange={(e) => { setSalaryOptions((prev) => ({ ...prev, normalizeIds: e.target.checked })); autoAuditSignature.current = ''; }}
                className="rounded border-slate-300"
              />
              <span className="text-slate-600">Normalize IDs</span>
            </label>

            {comparisonType === 'employee-data' && (
              <>
                <label className="flex items-center gap-1.5 text-sm text-slate-600">
                  <span>Digits</span>
                  <input
                    type="number"
                    min="1"
                    max="12"
                    value={dataOptions.keepDigits}
                    onChange={(e) => { setDataOptions((prev) => ({ ...prev, keepDigits: e.target.value })); autoAuditSignature.current = ''; }}
                    className="input w-20"
                  />
                </label>
                <label className="flex items-center gap-1.5 text-sm text-slate-600">
                  <span>Tolerance</span>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    value={dataOptions.tolerance}
                    onChange={(e) => { setDataOptions((prev) => ({ ...prev, tolerance: e.target.value })); autoAuditSignature.current = ''; }}
                    className="input w-24"
                  />
                </label>
              </>
            )}
          </div>
        )}

        {comparisonType === 'employee-data' && (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-slate-900">Auto-detected Payroll Fields</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  The audit runs automatically once both files and ID columns are loaded.
                </p>
              </div>
              <button onClick={() => handleEmployeeDataComparison(false)} disabled={loading || activeMappings.length === 0} className="btn btn-primary">
                {loading ? 'Auditing...' : 'Run Audit'}
              </button>
            </div>

            <div className="flex flex-wrap gap-2">
              {activeMappings.length > 0 ? activeMappings.map((mapping) => (
                <span key={`${mapping.file1}-${mapping.file2}`} className="badge badge-blue">
                  {mapping.label}
                </span>
              )) : <span className="text-sm text-slate-500">No shared payroll columns detected yet.</span>}
            </div>
          </div>
        )}

        {comparisonType === 'salary' && (
          <button onClick={handleSalaryComparison} disabled={loading} className="btn btn-primary">
            {loading ? 'Comparing...' : 'Compare Salary Column'}
          </button>
        )}

        {comparisonType === 'presence' && (
          <button onClick={handleEmployeeComparison} disabled={loading} className="btn btn-primary">
            {loading ? 'Comparing...' : 'Compare Employee Presence'}
          </button>
        )}

        {comparisonType === 'allowance' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Source File</label>
                <select
                  value={allowanceOptions.fileId}
                  onChange={async (e) => {
                    const id = e.target.value;
                    setAllowanceOptions((prev) => ({ ...prev, fileId: id }));
                    if (id) {
                      const cols = await getFileColumns(id);
                      setFile1Columns(cols.columns || []);
                      const identified = await identifyColumns(id);
                      setAllowanceOptions((prev) => ({
                        ...prev,
                        valueColumns: identified.allowances || [],
                      }));
                    }
                  }}
                  className="input"
                >
                  <option value="">Select file...</option>
                  {files.map((file) => (
                    <option key={file.id} value={file.id}>{file.filename}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-600 mb-1.5">Staff ID Column</label>
                <select value={allowanceOptions.staffIdColumn} onChange={(e) => setAllowanceOptions((prev) => ({ ...prev, staffIdColumn: e.target.value }))} className="input">
                  <option value="">Select column...</option>
                  {file1Columns.map((col) => <option key={col} value={col}>{col}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1.5">Value Columns</label>
              <div className="flex flex-wrap gap-2 max-h-32 overflow-y-auto p-2 border border-slate-200 rounded-md">
                {file1Columns.map((col) => (
                  <label key={col} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={allowanceOptions.valueColumns.includes(col)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setAllowanceOptions((prev) => ({ ...prev, valueColumns: [...prev.valueColumns, col] }));
                        } else {
                          setAllowanceOptions((prev) => ({ ...prev, valueColumns: prev.valueColumns.filter((item) => item !== col) }));
                        }
                      }}
                      className="rounded border-slate-300"
                    />
                    <span>{col}</span>
                  </label>
                ))}
              </div>
            </div>

            <button onClick={handleGenerateAllowances} disabled={loading} className="btn bg-emerald-600 text-white hover:bg-emerald-700">
              {loading ? 'Generating...' : 'Generate'}
            </button>
          </div>
        )}
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

          <div className="card p-4">
            <div className="flex items-center justify-between gap-4 mb-3">
              <div>
                <h2 className="text-sm font-medium text-slate-900">Preview of Payroll Differences</h2>
                <p className="text-xs text-slate-500 mt-1">Top mismatches from the detected payroll columns.</p>
              </div>
              <span className="badge badge-gray">{formatNumber(result.preview_differences?.length || 0)} preview rows</span>
            </div>
            <DataTable data={result.preview_differences || []} />
          </div>
        </div>
      )}

      {result?.type === 'salary' && result.summary && (
        <div className="card p-4 space-y-3">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard title="File 1" value={formatNumber(result.summary.total_file1)} tone="blue" />
            <MetricCard title="File 2" value={formatNumber(result.summary.total_file2)} tone="green" />
            <MetricCard title="Matched" value={formatNumber(result.summary.matched)} tone="slate" />
            <MetricCard title="Differences" value={formatNumber(result.summary.with_differences || 0)} tone="amber" />
          </div>
          {result.preview_differences?.length > 0 && <DataTable data={result.preview_differences} />}
        </div>
      )}

      {result?.type === 'presence' && (
        <div className="card p-4 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <MetricCard title="Common" value={formatNumber(result.common_employees)} tone="blue" />
            <MetricCard title="Only File 1" value={formatNumber(result.only_in_file1)} tone="amber" />
            <MetricCard title="Only File 2" value={formatNumber(result.only_in_file2)} tone="rose" />
          </div>
        </div>
      )}

      {result?.type === 'allowance' && result.files && (
        <div className="card p-4 space-y-2">
          <h2 className="text-sm font-medium text-slate-900">Generated Files</h2>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(result.files).map(([name, meta]) => (
              <button key={name} onClick={() => handleDownloadResult(meta.file_id)} className="btn btn-secondary text-xs">
                {name}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
