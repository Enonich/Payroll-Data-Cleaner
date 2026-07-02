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
  { label: 'Name',             aliases: ['name', 'employee name', 'fullname', 'full name'],                                    type: 'text',     category: 'identity'   },
  { label: 'Branch',           aliases: ['branch', 'location', 'office'],                                                      type: 'text',     category: 'identity'   },
  { label: 'Annual Salary',    aliases: ['annual salary', 'annualsalary'],                                                     type: 'currency', category: 'earnings'   },
  { label: 'Basic Salary',     aliases: ['basic salary', 'basicsalary', 'basic'],                                              type: 'currency', category: 'earnings'   },
  { label: 'Taxable Allowance',aliases: ['taxable allowance', 'taxableallowance'],                                             type: 'currency', category: 'allowances' },
  { label: '5.5% SSF',         aliases: ['5.5% ssf', '55 ssf', '55ssf', 'ssf 5.5', 'ssf5.5'],                                type: 'currency', category: 'deductions' },
  { label: '4.5% Staff PF',    aliases: ['4.5% staff pf', '45staffpf', 'staff pf', 'staffpf', '45 pf'],                      type: 'currency', category: 'deductions' },
  { label: 'Tax Relief',       aliases: ['tax relief', 'taxrelief'],                                                           type: 'currency', category: 'deductions' },
  { label: 'Taxable Salary',   aliases: ['taxable salary', 'taxablesalary'],                                                   type: 'currency', category: 'earnings'   },
  { label: 'Income Tax',       aliases: ['income tax', 'incometax', 'paye'],                                                   type: 'currency', category: 'deductions' },
  { label: 'Other Deductions', aliases: ['other deductions', 'otherdeductions'],                                               type: 'currency', category: 'deductions' },
  { label: 'Deductions',       aliases: ['deductions', 'deduction'],                                                           type: 'currency', category: 'deductions' },
  { label: 'Total Deductions', aliases: ['total deductions', 'totaldeductions'],                                               type: 'currency', category: 'deductions' },
  { label: 'Take Home',        aliases: ['take home', 'takehome', 'net pay', 'netpay'],                                        type: 'currency', category: 'earnings'   },
  { label: '13% SSF',          aliases: ['13% ssf', '13ssf'],                                                                  type: 'currency', category: 'deductions' },
  { label: '11% PF',           aliases: ['11% pf', '11pf'],                                                                   type: 'currency', category: 'deductions' },
  { label: '1st Tier (13.5%)', aliases: ['1st tier (13.5%)', '1st tier 13.5', '1sttier135', 'first tier 13.5'],               type: 'currency', category: 'deductions' },
  { label: '1st Tier (5%)',    aliases: ['1st tier (5%)', '1st tier 5', '1sttier5', 'first tier 5'],                          type: 'currency', category: 'deductions' },
  { label: '3rd Tier (15.5%)', aliases: ['3rd tier (15.5%)', '3rd tier 15.5', '3rdtier155', 'third tier 15.5'],               type: 'currency', category: 'deductions' },
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

// type: 'full' | 'allowances' | 'deductions'
function inferPayrollMappingsForType(columns1, columns2, type = 'full') {
  const used1 = new Set();
  const used2 = new Set();
  const mappings = [];

  const catalog = PAYROLL_FIELD_CATALOG.filter(field => {
    if (field.label === 'Name') return false;
    if (type === 'full')        return field.category !== 'identity';
    if (type === 'allowances')  return field.category === 'earnings' || field.category === 'allowances';
    if (type === 'deductions')  return field.category === 'earnings' || field.category === 'deductions';
    return false;
  });

  for (const field of catalog) {
    const col1 = findBestColumn(columns1, field.aliases, used1);
    const col2 = findBestColumn(columns2, field.aliases, used2);
    if (col1 && col2) {
      used1.add(col1);
      used2.add(col2);
      mappings.push({ file1: col1, file2: col2, label: field.label, type: field.type });
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

// ─── Audit type card selector ─────────────────────────────────────────────────
const AUDIT_TYPES = [
  { value: 'full',       label: 'Full Payroll Audit', description: 'All mapped payroll fields — earnings, allowances and deductions.', accent: 'blue'    },
  { value: 'allowances', label: 'Allowances Audit',   description: 'Earnings and allowance columns only.',                              accent: 'emerald' },
  { value: 'deductions', label: 'Deductions Audit',   description: 'Deduction and tax columns with earnings as context.',               accent: 'violet'  },
];

function AuditTypeSelector({ value, onChange }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
      {AUDIT_TYPES.map(opt => {
        const active = value === opt.value;
        const colors = {
          blue:    { border: 'border-blue-500',    bg: 'bg-blue-50',    title: 'text-blue-700',    dot: 'bg-blue-500'    },
          emerald: { border: 'border-emerald-500', bg: 'bg-emerald-50', title: 'text-emerald-700', dot: 'bg-emerald-500' },
          violet:  { border: 'border-violet-500',  bg: 'bg-violet-50',  title: 'text-violet-700',  dot: 'bg-violet-500'  },
        }[opt.accent];
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            className={`text-left rounded-xl border-2 p-4 transition-all focus:outline-none ${
              active
                ? `${colors.border} ${colors.bg} shadow-sm`
                : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
            }`}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className={`h-2.5 w-2.5 rounded-full ${active ? colors.dot : 'bg-slate-300'}`} />
              <span className={`text-sm font-semibold ${active ? colors.title : 'text-slate-700'}`}>{opt.label}</span>
            </div>
            <p className={`text-xs leading-relaxed ${active ? colors.title + ' opacity-80' : 'text-slate-500'}`}>{opt.description}</p>
          </button>
        );
      })}
    </div>
  );
}

// ─── Mode tab bar ─────────────────────────────────────────────────────────────
function ModeTabBar({ mode, onChange }) {
  const tabs = [
    { value: 'audit',  label: 'Payroll Audit'     },
    { value: 'column', label: 'Column Comparison'  },
  ];
  return (
    <div className="flex rounded-xl border border-slate-200 overflow-hidden w-fit bg-slate-50 p-1 gap-1">
      {tabs.map(tab => (
        <button
          key={tab.value}
          type="button"
          onClick={() => onChange(tab.value)}
          className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${
            mode === tab.value
              ? 'bg-white text-slate-900 shadow-sm'
              : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'
          }`}
        >
          {tab.label}
        </button>
      ))}
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

  const [mode,      setMode]      = useState('audit');   // 'audit' | 'column'
  const [auditType, setAuditType] = useState('full');    // 'full' | 'allowances' | 'deductions'

  const [matchOptions, setMatchOptions] = useState({
    idCol1:       '',
    idCol2:       '',
    nameCol1:     '',
    nameCol2:     '',
    normalizeIds: true,
    keepDigits:   5,
    tolerance:    0.01,
  });

  const [auditMappings,  setAuditMappings]  = useState([]);
  const [columnMappings, setColumnMappings] = useState([createEmptyMapping()]);

  const mappingFilePair = useRef('');

  function clearErrorDetails() { setErrorDetails(null); }

  function buildRequestContext() {
    return {
      mode,
      audit_type:          mode === 'audit' ? auditType : undefined,
      file1_id:            file1,
      file2_id:            file2,
      id_col1:             matchOptions.idCol1,
      id_col2:             matchOptions.idCol2,
      mapped_fields_count: activeMappings.length,
      mapped_fields:       activeMappings.map(m => m.label || `${m.file1} / ${m.file2}`),
    };
  }

  function captureError(error) {
    const detail   = error?.response?.data?.detail;
    let   message  = 'Unexpected error while processing request';
    const httpCode = error?.response?.status || null;

    if      (typeof detail === 'string' && detail.trim()) message = detail;
    else if (Array.isArray(detail))                        message = detail.map(i => i?.msg || JSON.stringify(i)).join('; ');
    else if (detail && typeof detail === 'object')         message = detail.message || JSON.stringify(detail);
    else if (error?.message)                               message = error.message;

    setErrorDetails({
      title:           mode === 'audit' ? 'Failed payroll audit request' : 'Failed comparison request',
      message,
      backend_code:    httpCode,
      timestamp:       new Date().toISOString(),
      request_context: buildRequestContext(),
    });
  }

  const activeMappings = useMemo(
    () => (mode === 'audit' ? auditMappings : columnMappings).filter(m => m.file1 && m.file2),
    [mode, auditMappings, columnMappings]
  );

  useEffect(() => { loadFiles(); }, []);

  useEffect(() => {
    if (file1) {
      loadFileColumns(file1, setFile1Columns);
      setMatchOptions(prev => ({ ...prev, idCol1: '', nameCol1: '' }));
    } else {
      setFile1Columns([]);
    }
  }, [file1]);

  useEffect(() => {
    if (file2) {
      loadFileColumns(file2, setFile2Columns);
      setMatchOptions(prev => ({ ...prev, idCol2: '', nameCol2: '' }));
    } else {
      setFile2Columns([]);
    }
  }, [file2]);

  useEffect(() => {
    if (file1Columns.length === 0) return;
    setMatchOptions(prev => ({
      ...prev,
      idCol1:   prev.idCol1   || inferIdColumn(file1Columns),
      nameCol1: prev.nameCol1 || inferNameColumn(file1Columns),
    }));
  }, [file1Columns]);

  useEffect(() => {
    if (file2Columns.length === 0) return;
    setMatchOptions(prev => ({
      ...prev,
      idCol2:   prev.idCol2   || inferIdColumn(file2Columns),
      nameCol2: prev.nameCol2 || inferNameColumn(file2Columns),
    }));
  }, [file2Columns]);

  useEffect(() => {
    if (file1Columns.length === 0 || file2Columns.length === 0) return;
    if (mode === 'audit') {
      const pairKey = `${file1}|${file2}|${auditType}`;
      if (mappingFilePair.current === pairKey) return;
      mappingFilePair.current = pairKey;
      setAuditMappings(inferPayrollMappingsForType(file1Columns, file2Columns, auditType));
      setResult(null);
      setReconciliationRun(null);
    } else {
      const pairKey = `${file1}|${file2}`;
      if (mappingFilePair.current === pairKey) return;
      mappingFilePair.current = pairKey;
      const inferred = inferPayrollMappingsForType(file1Columns, file2Columns, 'full');
      setColumnMappings(inferred.length > 0 ? inferred : [createEmptyMapping()]);
      setResult(null);
      setReconciliationRun(null);
    }
  }, [file1, file2, file1Columns, file2Columns, auditType, mode]);

  useEffect(() => {
    if (mode !== 'audit' || file1Columns.length === 0 || file2Columns.length === 0) return;
    setAuditMappings(inferPayrollMappingsForType(file1Columns, file2Columns, auditType));
    setResult(null);
    setReconciliationRun(null);
  }, [auditType]); // eslint-disable-line react-hooks/exhaustive-deps

  function addColumnMapping() {
    setColumnMappings(prev => [...prev, createEmptyMapping()]);
  }

  function removeColumnMapping(index) {
    setColumnMappings(prev => prev.filter((_, i) => i !== index));
  }

  function updateColumnMapping(index, field, value) {
    setColumnMappings(prev => prev.map((mapping, i) => {
      if (i !== index) return mapping;
      const next = { ...mapping, [field]: value };
      if ((field === 'file1' || field === 'file2') && !next.label) {
        const col1 = field === 'file1' ? value : next.file1;
        const col2 = field === 'file2' ? value : next.file2;
        if (col1 && col2) next.label = col1 === col2 ? col1 : `${col1} / ${col2}`;
      }
      if (field === 'file1' || field === 'file2' || field === 'label') {
        next.type = inferFieldType(next.file1, next.file2, next.label);
      }
      return next;
    }));
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

  async function handleRun() {
    if (!file1 || !file2 || !matchOptions.idCol1 || !matchOptions.idCol2) {
      toast.error('Select both files and employee ID columns');
      return;
    }
    if (activeMappings.length === 0) {
      toast.error(mode === 'audit' ? 'No matching payroll fields found — try different files' : 'Add at least one column pair');
      return;
    }

    setLoading(true);
    clearErrorDetails();
    try {
      const data = await compareEmployeeData({
        file1_id:        file1,
        file2_id:        file2,
        id_col1:         matchOptions.idCol1,
        id_col2:         matchOptions.idCol2,
        column_mappings: activeMappings,
        name_col1:       matchOptions.nameCol1 || null,
        name_col2:       matchOptions.nameCol2 || null,
        normalize_ids:   matchOptions.normalizeIds,
        keep_digits:     Number(matchOptions.keepDigits) || 5,
        tolerance:       Number(matchOptions.tolerance)  || 0.01,
        use_ai:          mode === 'audit',
      });
      setResult({ type: 'employee-data', ...data });
      setReconciliationExport(null);
      if (mode === 'audit' && data.reconciliation_run?.id) {
        await refreshReconciliationRun(data.reconciliation_run.id);
      } else {
        setReconciliationRun(null);
      }
      if (data.reconciliation_warning) {
        toast.error(`Completed, but review setup failed: ${data.reconciliation_warning}`);
      }
      clearErrorDetails();
      toast.success(mode === 'audit' ? 'Payroll audit completed' : 'Comparison completed');
    } catch (error) {
      captureError(error);
      toast.error(error.response?.data?.detail || 'Request failed');
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

  const selectedFileNames = useMemo(() => ({
    fileA: files.find(f => f.id === file1)?.filename,
    fileB: files.find(f => f.id === file2)?.filename,
  }), [files, file1, file2]);

  const visibleReconciliationIssues = useMemo(
    () => (reconciliationRun?.issues || []).slice(0, 40),
    [reconciliationRun]
  );

  const approvedIssueCount = reconciliationRun?.status_counts?.approved || 0;
  const canRun = file1 && file2 && matchOptions.idCol1 && matchOptions.idCol2 && activeMappings.length > 0;

  return (
    <div className="space-y-5">

      {/* ── Header + mode selector ───────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-base font-semibold text-slate-900">Compare &amp; Audit</h1>
          <p className="text-xs text-slate-500 mt-0.5">
            {mode === 'audit'
              ? 'Run a structured payroll audit across two files with AI-assisted analysis.'
              : 'Compare specific columns from two files side by side.'}
          </p>
        </div>
        <ModeTabBar
          mode={mode}
          onChange={next => {
            setMode(next);
            setResult(null);
            setReconciliationRun(null);
            mappingFilePair.current = '';
          }}
        />
      </div>

      {/* ── Configuration card ────────────────────────────────────────────── */}
      <div className="card divide-y divide-slate-100">

        {/* File selection — shared between modes */}
        <div className="p-5 space-y-4">
          <div>
            <h2 className="text-sm font-semibold text-slate-900">File Selection</h2>
            <p className="text-xs text-slate-500 mt-0.5">Choose the two payroll exports to compare.</p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* File 1 */}
            <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">File 1</p>
              <FormField label="Payroll file" tooltip="The first payroll export.">
                <select value={file1} onChange={e => { setFile1(e.target.value); setResult(null); mappingFilePair.current = ''; }} className="input">
                  <option value="">Select file…</option>
                  {files.map(f => <option key={f.id} value={f.id}>{f.filename}</option>)}
                </select>
              </FormField>
              <FormField label="Employee ID column" tooltip="Column that uniquely identifies each employee in this file.">
                <select value={matchOptions.idCol1} onChange={e => setMatchOptions(prev => ({ ...prev, idCol1: e.target.value }))} className="input">
                  <option value="">Select ID column…</option>
                  {file1Columns.map(col => <option key={col} value={col}>{col}</option>)}
                </select>
              </FormField>
              {mode === 'audit' && (
                <FormField label="Name column" tooltip="Optional. Used for name-mismatch checks in the audit.">
                  <select value={matchOptions.nameCol1} onChange={e => setMatchOptions(prev => ({ ...prev, nameCol1: e.target.value }))} className="input">
                    <option value="">No name column</option>
                    {file1Columns.map(col => <option key={col} value={col}>{col}</option>)}
                  </select>
                </FormField>
              )}
            </div>

            {/* File 2 */}
            <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50/50 p-4">
              <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">File 2</p>
              <FormField label="Payroll file" tooltip="The second payroll export.">
                <select value={file2} onChange={e => { setFile2(e.target.value); setResult(null); mappingFilePair.current = ''; }} className="input">
                  <option value="">Select file…</option>
                  {files.map(f => <option key={f.id} value={f.id}>{f.filename}</option>)}
                </select>
              </FormField>
              <FormField label="Employee ID column" tooltip="Must correspond to the same employees as File 1.">
                <select value={matchOptions.idCol2} onChange={e => setMatchOptions(prev => ({ ...prev, idCol2: e.target.value }))} className="input">
                  <option value="">Select ID column…</option>
                  {file2Columns.map(col => <option key={col} value={col}>{col}</option>)}
                </select>
              </FormField>
              {mode === 'audit' && (
                <FormField label="Name column" tooltip="Paired with File 1 name column for name mismatch checks.">
                  <select value={matchOptions.nameCol2} onChange={e => setMatchOptions(prev => ({ ...prev, nameCol2: e.target.value }))} className="input">
                    <option value="">No name column</option>
                    {file2Columns.map(col => <option key={col} value={col}>{col}</option>)}
                  </select>
                </FormField>
              )}
            </div>
          </div>

          {/* Matching options */}
          <div className="flex flex-wrap items-center gap-4 pt-1">
            <label className="flex items-center gap-1.5 text-sm">
              <input
                type="checkbox"
                checked={matchOptions.normalizeIds}
                onChange={e => setMatchOptions(prev => ({ ...prev, normalizeIds: e.target.checked }))}
                className="rounded border-slate-300"
              />
              <span className="text-slate-800 font-medium">Normalize IDs</span>
              <FieldTooltip label="Normalize IDs" text="Strips formatting from ID values so EMP-00123 and 123 can still match." />
            </label>
            <label className="flex items-center gap-1.5 text-sm text-slate-800">
              <span className="font-medium">ID digits to keep</span>
              <FieldTooltip label="ID digits to keep" text="When normalizing, only the last N digits are kept. Useful when files use different ID lengths." />
              <input type="number" min="1" max="12" value={matchOptions.keepDigits}
                onChange={e => setMatchOptions(prev => ({ ...prev, keepDigits: e.target.value }))}
                className="input w-20" />
            </label>
            <label className="flex items-center gap-1.5 text-sm text-slate-800">
              <span className="font-medium">Numeric tolerance</span>
              <FieldTooltip label="Numeric tolerance" text="Differences below this amount are treated as equal and not flagged." />
              <input type="number" min="0" step="0.01" value={matchOptions.tolerance}
                onChange={e => setMatchOptions(prev => ({ ...prev, tolerance: e.target.value }))}
                className="input w-24" />
            </label>
          </div>
        </div>

        {/* ── Payroll Audit mode config ────────────────────────────────────── */}
        {mode === 'audit' && (
          <div className="p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Audit Type</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Choose what area of the payroll to focus on. Fields are auto-detected from your files.
              </p>
            </div>

            <AuditTypeSelector value={auditType} onChange={setAuditType} />

            {/* Auto-detected fields preview */}
            {auditMappings.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-2">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                  Auto-detected fields ({auditMappings.length})
                </p>
                <div className="flex flex-wrap gap-2">
                  {auditMappings.map((m, i) => (
                    <span key={i} className="inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-700">
                      <span className="font-medium">{m.label || m.file1}</span>
                      {m.file1 !== m.file2 && <span className="text-slate-400">{m.file1} → {m.file2}</span>}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {auditMappings.length === 0 && file1 && file2 && file1Columns.length > 0 && file2Columns.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                No matching fields found for this audit type. Try a different audit type or different files.
              </div>
            )}

            <div className="flex justify-end pt-1">
              <button onClick={handleRun} disabled={loading || !canRun} className="btn btn-primary px-6">
                {loading ? 'Auditing…' : 'Start Audit'}
              </button>
            </div>
          </div>
        )}

        {/* ── Column Comparison mode config ────────────────────────────────── */}
        {mode === 'column' && (
          <div className="p-5 space-y-4">
            <div>
              <h2 className="text-sm font-semibold text-slate-900">Column Pairs</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Map a column from File 1 to a column in File 2 for each field you want to compare.
              </p>
            </div>

            <div className="overflow-x-auto border border-slate-200 rounded-xl">
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
                  {columnMappings.map((mapping, index) => (
                    <tr key={`mapping-${index}`}>
                      <td>
                        <input
                          type="text"
                          value={mapping.label}
                          onChange={e => updateColumnMapping(index, 'label', e.target.value)}
                          placeholder="Label"
                          className="input text-xs"
                        />
                      </td>
                      <td>
                        <select value={mapping.file1} onChange={e => updateColumnMapping(index, 'file1', e.target.value)} className="input text-xs">
                          <option value="">Select column…</option>
                          {file1Columns.map(col => <option key={col} value={col}>{col}</option>)}
                        </select>
                      </td>
                      <td>
                        <select value={mapping.file2} onChange={e => updateColumnMapping(index, 'file2', e.target.value)} className="input text-xs">
                          <option value="">Select column…</option>
                          {file2Columns.map(col => <option key={col} value={col}>{col}</option>)}
                        </select>
                      </td>
                      <td>
                        <button
                          type="button"
                          onClick={() => removeColumnMapping(index)}
                          disabled={columnMappings.length <= 1}
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
              <button onClick={handleRun} disabled={loading || !canRun} className="btn btn-primary">
                {loading ? 'Comparing…' : 'Run Comparison'}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* ── Error card ────────────────────────────────────────────────────── */}
      {errorDetails && (
        <div className="card p-4 border border-rose-200 bg-rose-50/60 space-y-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-rose-800">{errorDetails.title}</h2>
              <p className="text-sm text-rose-700 mt-1">{errorDetails.message}</p>
              <p className="text-xs text-rose-600 mt-1">
                {errorDetails.backend_code ? `HTTP ${errorDetails.backend_code}` : 'No HTTP status'} • {new Date(errorDetails.timestamp).toLocaleString()}
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

      {/* ── Results ───────────────────────────────────────────────────────── */}
      {result?.type === 'employee-data' && result.summary && (
        <div className="space-y-4">

          {/* Summary metrics — both modes */}
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <MetricCard title="Matched Employees"          value={formatNumber(result.summary.matched)}                       subtitle={`${selectedFileNames.fileA || 'File 1'} vs ${selectedFileNames.fileB || 'File 2'}`} tone="blue"  />
            <MetricCard title="Employees With Differences" value={formatNumber(result.summary.employees_with_differences)}    subtitle={`${formatNumber(result.summary.field_differences)} field-level mismatches`}               tone="amber" />
            <MetricCard title="Only In File 1"             value={formatNumber(result.summary.only_in_file1)}                 subtitle="Employees missing from File 2"                                                         tone="rose"  />
            <MetricCard title="Only In File 2"             value={formatNumber(result.summary.only_in_file2)}                 subtitle="Employees missing from File 1"                                                         tone="green" />
          </div>

          {/* ── Audit-mode results ─────────────────────────────────────────── */}
          {mode === 'audit' && (
            <>
              <AIAuditPanel audit={result.ai_audit} />

              <MatchingColumnsNotice matching={result.matching_columns} />
              <NameColumnsNotice     names={result.name_columns}       />

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <div className="card p-4 xl:col-span-2 space-y-3">
                  <div>
                    <h2 className="text-sm font-medium text-slate-900">Coverage Across Both Files</h2>
                    <p className="text-xs text-slate-500 mt-1">Shared employees versus records found in only one file.</p>
                  </div>
                  <StackedPresenceBar summary={result.summary} />
                </div>

                <div className="card p-4 space-y-3">
                  <div>
                    <h2 className="text-sm font-medium text-slate-900">Payroll Impact</h2>
                    <p className="text-xs text-slate-500 mt-1">Largest variance across numeric fields.</p>
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
                      <div className="text-sm text-slate-600 mt-1">{formatCurrency(result.analytics.largest_variance_field.total_abs_difference || 0)} total variance</div>
                      <div className="text-xs text-slate-500 mt-1">{formatNumber(result.analytics.largest_variance_field.affected_employees || 0)} employees affected</div>
                    </div>
                  )}
                </div>
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <div className="card p-4 xl:col-span-2 space-y-3">
                  <div>
                    <h2 className="text-sm font-medium text-slate-900">Difference Concentration By Field</h2>
                    <p className="text-xs text-slate-500 mt-1">Fields with the largest difference volume are shown first.</p>
                  </div>
                  <FieldImpactChart fieldSummary={result.analytics?.field_summary} />
                </div>
                <div className="space-y-4">
                  <PresenceList title="Only In File 1" rows={result.presence_preview?.only_in_file1} tone="amber" />
                  <PresenceList title="Only In File 2" rows={result.presence_preview?.only_in_file2} tone="green" />
                </div>
              </div>

              {(result.duplicate_id_samples?.file1?.length > 0 || result.duplicate_id_samples?.file2?.length > 0) && (
                <div className="card p-4 space-y-2">
                  <h2 className="text-sm font-medium text-slate-900">Duplicate ID Samples</h2>
                  {result.duplicate_id_samples.file1?.length > 0 && <p className="text-xs text-slate-600">File 1: {result.duplicate_id_samples.file1.join(', ')}</p>}
                  {result.duplicate_id_samples.file2?.length > 0 && <p className="text-xs text-slate-600">File 2: {result.duplicate_id_samples.file2.join(', ')}</p>}
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

              {/* Reconciliation workbench */}
              {reconciliationRun && (
                <div className="card divide-y divide-slate-100">
                  <div className="p-5 flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-900">Reconciliation Review Workbench</h2>
                      <p className="text-xs text-slate-500 mt-1">
                        Approve valid HR changes, reject incorrect differences, or ignore items that do not need action.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-1.5 items-center">
                      {Object.entries(reconciliationRun.status_counts || {}).map(([status, count]) => (
                        <span key={status} className="badge badge-gray">{status}: {formatNumber(count)}</span>
                      ))}
                      <button
                        onClick={handleExportApprovedUpdates}
                        disabled={exportingReconciliation || approvedIssueCount === 0}
                        className="btn btn-primary text-xs disabled:opacity-40"
                      >
                        {exportingReconciliation ? 'Exporting…' : 'Export Approved HR Updates'}
                      </button>
                    </div>
                  </div>

                  {reconciliationExport?.files && Object.keys(reconciliationExport.files).length > 0 && (
                    <div className="px-5 py-3 rounded-md border border-emerald-100 bg-emerald-50">
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

                  <div className="overflow-hidden">
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
                        {visibleReconciliationIssues.map(issue => (
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
                                  <button onClick={() => handleReconciliationAction(issue.id, 'approve')} disabled={reconciliationActionId === issue.id} className="btn btn-secondary text-[11px] px-2 py-1">Approve</button>
                                )}
                                {issue.status !== 'rejected' && (
                                  <button onClick={() => handleReconciliationAction(issue.id, 'reject')} disabled={reconciliationActionId === issue.id} className="btn btn-secondary text-[11px] px-2 py-1">Reject</button>
                                )}
                                {issue.status !== 'ignored' && (
                                  <button onClick={() => handleReconciliationAction(issue.id, 'ignore')} disabled={reconciliationActionId === issue.id} className="btn btn-secondary text-[11px] px-2 py-1">Ignore</button>
                                )}
                                {issue.status !== 'open' && (
                                  <button onClick={() => handleReconciliationAction(issue.id, 'reopen')} disabled={reconciliationActionId === issue.id} className="btn btn-secondary text-[11px] px-2 py-1">Reopen</button>
                                )}
                              </div>
                            </td>
                          </tr>
                        ))}
                        {visibleReconciliationIssues.length === 0 && (
                          <tr><td colSpan={8}>No reconciliation issues were generated.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {(reconciliationRun.issues || []).length > visibleReconciliationIssues.length && (
                    <p className="px-5 py-3 text-xs text-slate-500">
                      Showing {formatNumber(visibleReconciliationIssues.length)} of {formatNumber(reconciliationRun.issues.length)} issues.
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── Column-comparison results ──────────────────────────────────── */}
          {mode === 'column' && (
            <>
              <MatchingColumnsNotice matching={result.matching_columns} />
              {(result.duplicate_id_samples?.file1?.length > 0 || result.duplicate_id_samples?.file2?.length > 0) && (
                <div className="card p-4 space-y-2">
                  <h2 className="text-sm font-medium text-slate-900">Duplicate ID Samples</h2>
                  {result.duplicate_id_samples.file1?.length > 0 && <p className="text-xs text-slate-600">File 1: {result.duplicate_id_samples.file1.join(', ')}</p>}
                  {result.duplicate_id_samples.file2?.length > 0 && <p className="text-xs text-slate-600">File 2: {result.duplicate_id_samples.file2.join(', ')}</p>}
                </div>
              )}
              {result.files_created && Object.keys(result.files_created).length > 0 && (
                <div className="card p-4 space-y-2">
                  <h2 className="text-sm font-medium text-slate-900">Download Comparison Files</h2>
                  <div className="flex flex-wrap gap-1.5">
                    {Object.entries(result.files_created).map(([name, id]) => (
                      <button key={name} onClick={() => handleDownloadResult(typeof id === 'object' ? id.file_id : id)} className="btn btn-secondary text-xs">
                        {name}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* Differences table — both modes */}
          <div className="card p-4">
            <div className="flex items-center justify-between gap-4 mb-3">
              <div>
                <h2 className="text-sm font-medium text-slate-900">
                  {mode === 'audit' ? 'Preview of Payroll Differences' : 'Column Differences'}
                </h2>
                <p className="text-xs text-slate-500 mt-1">
                  {mode === 'audit' ? 'Top mismatches from your selected audit fields.' : 'Rows where the compared columns differ.'}
                </p>
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
