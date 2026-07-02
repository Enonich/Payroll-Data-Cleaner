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
  applyBulkReconciliationAction,
  exportApprovedReconciliationUpdates,
  downloadCsv,
  getColumnDefinitions,
  addColumnDefinitionEntry,
  replaceColumnDefinitions,
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
function inferPayrollMappingsForType(columns1, columns2, type = 'full', catalog = PAYROLL_FIELD_CATALOG) {
  const used1 = new Set();
  const used2 = new Set();
  const mappings = [];

  const filtered = catalog.filter(field => {
    if (field.label === 'Name') return false;
    if (type === 'full')        return field.category !== 'identity';
    if (type === 'allowances')  return field.category === 'earnings' || field.category === 'allowances';
    if (type === 'deductions')  return field.category === 'earnings' || field.category === 'deductions';
    return false;
  });

  for (const field of filtered) {
    const col1 = findBestColumn(columns1, field.aliases, used1);
    const col2 = findBestColumn(columns2, field.aliases, used2);
    if (col1 && col2) {
      used1.add(col1);
      used2.add(col2);
      mappings.push({ file1: col1, file2: col2, label: field.label, type: field.type, category: field.category });
    }
  }
  return mappings;
}

// Merge API-loaded column definition entries with the base catalog.
// API entries whose label already exists in the base catalog are skipped.
function buildMergedCatalog(apiEntries) {
  const base = PAYROLL_FIELD_CATALOG;
  const baseLabels = new Set(base.map(e => e.label.toLowerCase()));
  const extras = (apiEntries || [])
    .filter(e => !baseLabels.has((e.label || '').toLowerCase()))
    .map(e => ({
      label:    e.label,
      aliases:  Array.isArray(e.aliases) ? e.aliases : [],
      type:     e.type || 'currency',
      category: e.category || 'allowances',
    }));
  return [...base, ...extras];
}

// Find columns in both files that were NOT matched by any catalog entry.
// Returns array of { col1, col2, label, category } objects ready for the user to classify.
function computeUndetectedColumns(cols1, cols2, currentMappings, idCol1, idCol2, nameCol1, nameCol2) {
  const mappedFile1 = new Set(currentMappings.map(m => m.file1).filter(Boolean));
  const mappedFile2 = new Set(currentMappings.map(m => m.file2).filter(Boolean));
  const exclude1 = new Set([idCol1, nameCol1].filter(Boolean));
  const exclude2 = new Set([idCol2, nameCol2].filter(Boolean));

  const undetected1 = cols1.filter(c => !mappedFile1.has(c) && !exclude1.has(c));
  const undetected2 = cols2.filter(c => !mappedFile2.has(c) && !exclude2.has(c));

  const pairs = [];
  const used2 = new Set();

  for (const col1 of undetected1) {
    let bestMatch = '';
    let bestScore = 0;
    for (const col2 of undetected2) {
      if (used2.has(col2)) continue;
      const score = scoreColumnMatch(col1, [col2]);
      if (score > bestScore) { bestScore = score; bestMatch = col2; }
    }
    if (bestMatch && bestScore >= 40) {
      used2.add(bestMatch);
      pairs.push({ col1, col2: bestMatch, label: col1, category: 'allowances', include: false });
    } else {
      pairs.push({ col1, col2: '', label: col1, category: 'allowances', include: false });
    }
  }
  for (const col2 of undetected2) {
    if (!used2.has(col2)) {
      pairs.push({ col1: '', col2, label: col2, category: 'allowances', include: false });
    }
  }
  return pairs;
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

// ─── Severity config ──────────────────────────────────────────────────────────
const SEV_CONFIG = {
  critical: { bar: 'bg-red-500',    badge: 'bg-red-100 text-red-700 border-red-200',    card: 'border-red-200 bg-red-50/40',    icon: '⚠', label: 'Critical' },
  high:     { bar: 'bg-orange-500', badge: 'bg-orange-100 text-orange-700 border-orange-200', card: 'border-orange-200 bg-orange-50/40', icon: '⚡', label: 'High'     },
  medium:   { bar: 'bg-yellow-400', badge: 'bg-yellow-100 text-yellow-700 border-yellow-200', card: 'border-yellow-200 bg-yellow-50/40', icon: '◈', label: 'Medium'   },
  low:      { bar: 'bg-emerald-500',badge: 'bg-emerald-100 text-emerald-700 border-emerald-200', card: 'border-emerald-200 bg-emerald-50/40', icon: '✓', label: 'Low' },
};

const RISK_BANNER = {
  critical: 'bg-red-600',
  high:     'bg-orange-500',
  medium:   'bg-yellow-500',
  low:      'bg-emerald-500',
  unknown:  'bg-slate-400',
};

const CATEGORY_LABELS = {
  net_pay:         'Net Pay',
  paye:            'PAYE / Tax',
  ssnit:           'SSNIT',
  provident_fund:  'Provident Fund',
  allowances:      'Allowances',
  presence:        'Presence',
  duplicates:      'Duplicates',
  names:           'Names',
  account_numbers: 'Account No.',
  salary:          'Salary',
  cross_field:     'Cross-Field',
  data_quality:    'Data Quality',
};

function SeverityBadge({ severity }) {
  const cfg = SEV_CONFIG[severity?.toLowerCase()] || SEV_CONFIG.low;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${cfg.badge}`}>
      <span>{cfg.icon}</span>{cfg.label}
    </span>
  );
}

function FindingCard({ finding, index }) {
  const [open, setOpen] = useState(false);
  const cfg = SEV_CONFIG[finding.severity?.toLowerCase()] || SEV_CONFIG.low;
  const catLabel = CATEGORY_LABELS[finding.category] || (finding.category || 'Finding');

  return (
    <div className={`rounded-xl border ${cfg.card} overflow-hidden transition-shadow hover:shadow-sm`}>
      {/* colour bar */}
      <div className={`h-1 w-full ${cfg.bar}`} />
      <div className="p-4 space-y-2">
        {/* header row */}
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 bg-slate-100 rounded px-1.5 py-0.5">
              #{index + 1}
            </span>
            <span className="text-[11px] font-medium text-slate-500 bg-white/80 border border-slate-200 rounded-full px-2 py-0.5">
              {catLabel}
            </span>
            {finding.affected_count > 0 && (
              <span className="text-[11px] text-slate-400">{finding.affected_count} affected</span>
            )}
          </div>
          <SeverityBadge severity={finding.severity} />
        </div>

        {/* finding text */}
        <p className="text-sm text-slate-800 leading-relaxed">{finding.finding}</p>

        {/* recommended action */}
        {finding.recommended_action && (
          <div className="flex items-start gap-2 rounded-lg bg-white/60 border border-slate-200 px-3 py-2">
            <span className="text-blue-500 mt-0.5 flex-shrink-0 text-xs font-bold">→</span>
            <p className="text-xs text-slate-700 leading-relaxed">{finding.recommended_action}</p>
          </div>
        )}

        {/* collapsible evidence */}
        {finding.evidence && (
          <button
            type="button"
            onClick={() => setOpen(o => !o)}
            className="text-[11px] text-slate-400 hover:text-slate-600 flex items-center gap-1 transition-colors"
          >
            <span>{open ? '▾' : '▸'}</span> Evidence
          </button>
        )}
        {open && finding.evidence && (
          <div className="rounded-lg bg-slate-900 px-3 py-2 mt-1">
            <p className="text-[11px] text-slate-300 font-mono leading-relaxed whitespace-pre-wrap break-all">
              {finding.evidence}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function StatutoryGrid({ compliance }) {
  if (!compliance) return null;
  const checks = [
    { key: 'ssnit_ok',   label: 'SSNIT' },
    { key: 'paye_ok',    label: 'PAYE'  },
    { key: 'net_pay_ok', label: 'Net Pay' },
    { key: 'ssf_ok',     label: 'SSF'   },
  ];
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {checks.map(({ key, label }) => {
          const val = compliance[key];
          const status = val === true ? 'ok' : val === false ? 'fail' : 'unknown';
          const cls = {
            ok:      'bg-emerald-50 border-emerald-200 text-emerald-700',
            fail:    'bg-red-50 border-red-200 text-red-700',
            unknown: 'bg-slate-50 border-slate-200 text-slate-500',
          }[status];
          const icon = { ok: '✓', fail: '✗', unknown: '—' }[status];
          return (
            <div key={key} className={`rounded-lg border p-2 text-center ${cls}`}>
              <div className="text-lg font-bold">{icon}</div>
              <div className="text-[11px] font-medium uppercase tracking-wide mt-0.5">{label}</div>
            </div>
          );
        })}
      </div>
      {compliance.notes && (
        <p className="text-[11px] text-slate-500 italic">{compliance.notes}</p>
      )}
    </div>
  );
}

function AIAuditPanel({ audit }) {
  const [activeTab, setActiveTab] = useState('findings');
  if (!audit) return null;

  const risk        = String(audit.risk_level || 'unknown').toLowerCase();
  const riskBanner  = RISK_BANNER[risk] || RISK_BANNER.unknown;
  const findings    = audit.key_findings || [];
  const severityOrder = ['critical', 'high', 'medium', 'low'];
  const sorted = [...findings].sort((a, b) => {
    const ai = severityOrder.indexOf(String(a.severity || '').toLowerCase());
    const bi = severityOrder.indexOf(String(b.severity || '').toLowerCase());
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const sevCounts = findings.reduce((acc, f) => {
    const s = String(f.severity || 'low').toLowerCase();
    acc[s] = (acc[s] || 0) + 1;
    return acc;
  }, {});

  const tabs = [
    { id: 'findings',   label: `Findings (${findings.length})` },
    { id: 'statutory',  label: 'Statutory' },
    { id: 'actions',    label: `Actions (${(audit.recommended_actions || []).length})` },
  ];

  return (
    <div className="card overflow-hidden">
      {/* risk banner */}
      <div className={`${riskBanner} px-5 py-3 flex items-center justify-between gap-3 flex-wrap`}>
        <div className="flex items-center gap-3">
          <div>
            <p className="text-xs font-semibold text-white/80 uppercase tracking-widest">AI Payroll Audit</p>
            <p className="text-white font-semibold text-sm mt-0.5">
              Risk Level: {risk.charAt(0).toUpperCase() + risk.slice(1)}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {sevCounts.critical > 0 && <span className="bg-white/20 text-white text-xs font-semibold rounded-full px-2 py-0.5">{sevCounts.critical} critical</span>}
          {sevCounts.high     > 0 && <span className="bg-white/20 text-white text-xs font-semibold rounded-full px-2 py-0.5">{sevCounts.high} high</span>}
          {sevCounts.medium   > 0 && <span className="bg-white/20 text-white text-xs font-semibold rounded-full px-2 py-0.5">{sevCounts.medium} medium</span>}
          {sevCounts.low      > 0 && <span className="bg-white/20 text-white text-xs font-semibold rounded-full px-2 py-0.5">{sevCounts.low} low</span>}
          {audit.chunks_total > 0 && (
            <span className="bg-white/10 text-white/80 text-xs rounded-full px-2 py-0.5">
              {audit.chunks_processed}/{audit.chunks_total} AI chunks
              {audit.chunks_with_fallback > 0 ? ` (${audit.chunks_with_fallback} fallback)` : ''}
            </span>
          )}
        </div>
      </div>

      <div className="p-5 space-y-4">
        {/* model + availability */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs text-slate-500">
            {audit.available ? `Model: ${audit.model}` : `AI unavailable — ${audit.model}`}
          </span>
          {!audit.available && (
            <span className="badge badge-yellow">Deterministic fallback active</span>
          )}
        </div>

        {/* warning box */}
        {audit.warning && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            <p className="font-medium mb-0.5">AI layer note</p>
            <p>{audit.warning}</p>
          </div>
        )}

        {/* executive summary */}
        {audit.executive_summary && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-400 mb-1.5">Executive Summary</p>
            <p className="text-sm text-slate-800 leading-relaxed">{audit.executive_summary}</p>
          </div>
        )}

        {/* tab bar */}
        <div className="flex rounded-lg border border-slate-200 overflow-hidden w-fit bg-slate-50 p-0.5 gap-0.5">
          {tabs.map(tab => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`px-4 py-1.5 rounded text-xs font-medium transition-all ${
                activeTab === tab.id
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-500 hover:text-slate-700 hover:bg-white/60'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* findings tab */}
        {activeTab === 'findings' && (
          <div className="space-y-3">
            {sorted.length === 0 ? (
              <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-center">
                <p className="text-2xl mb-1">✓</p>
                <p className="text-sm font-semibold text-emerald-800">No issues found</p>
                <p className="text-xs text-emerald-600 mt-0.5">All deterministic checks passed.</p>
              </div>
            ) : (
              sorted.map((finding, index) => (
                <FindingCard key={`${finding.category}-${index}`} finding={finding} index={index} />
              ))
            )}
          </div>
        )}

        {/* statutory compliance tab */}
        {activeTab === 'statutory' && (
          <StatutoryGrid compliance={audit.statutory_compliance} />
        )}

        {/* recommended actions tab */}
        {activeTab === 'actions' && (
          <div className="space-y-2">
            {(audit.recommended_actions || []).length === 0 ? (
              <p className="text-sm text-slate-500">No specific actions recommended.</p>
            ) : (
              (audit.recommended_actions || []).map((action, i) => (
                <div key={i} className="flex items-start gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
                  <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-100 text-blue-700 text-[11px] font-bold flex items-center justify-center mt-0.5">
                    {i + 1}
                  </span>
                  <p className="text-sm text-slate-700 leading-relaxed">{action}</p>
                </div>
              ))
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Column classification override panel ────────────────────────────────────

const CATEGORY_OPTIONS = [
  { value: 'auto',       label: 'Auto' },
  { value: 'earnings',   label: 'Earnings' },
  { value: 'allowances', label: 'Allowance' },
  { value: 'deductions', label: 'Deduction' },
  { value: 'identity',   label: 'Identity' },
];

const CAT_PILL = {
  earnings:   'bg-blue-100 text-blue-700',
  allowances: 'bg-emerald-100 text-emerald-700',
  deductions: 'bg-red-100 text-red-700',
  identity:   'bg-slate-100 text-slate-600',
  auto:       'bg-slate-100 text-slate-500',
};

function ColumnClassificationPanel({ mappings, onChangeCategoryOverride }) {
  if (!mappings || mappings.length === 0) return null;

  return (
    <div className="space-y-2">
      <p className="text-xs text-slate-500 leading-relaxed">
        If the automatic category detection is incorrect for any column, override it here.
        These classifications help the AI understand your payroll structure.
      </p>
      <div className="rounded-xl border border-slate-200 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wide">Field Label</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wide hidden sm:table-cell">File 1 Column</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wide hidden sm:table-cell">File 2 Column</th>
              <th className="text-left px-4 py-2 text-xs font-semibold text-slate-500 uppercase tracking-wide">Category</th>
            </tr>
          </thead>
          <tbody>
            {mappings.map((m, i) => {
              const current = m.category || 'auto';
              return (
                <tr key={i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50">
                  <td className="px-4 py-2.5 font-medium text-slate-800 text-xs">{m.label || m.file1}</td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs hidden sm:table-cell">{m.file1}</td>
                  <td className="px-4 py-2.5 text-slate-500 text-xs hidden sm:table-cell">{m.file2}</td>
                  <td className="px-4 py-2.5">
                    <select
                      value={current}
                      onChange={e => onChangeCategoryOverride(i, e.target.value)}
                      className={`text-xs font-medium rounded-full px-2 py-0.5 border-0 outline-none cursor-pointer ${CAT_PILL[current] || CAT_PILL.auto} appearance-none pr-5`}
                      style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'%3E%3Cpath fill=\'%23888\' d=\'M0 0l5 6 5-6z\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.35rem center' }}
                    >
                      {CATEGORY_OPTIONS.map(opt => (
                        <option key={opt.value} value={opt.value}>{opt.label}</option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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

// ─── Undetected Columns panel ─────────────────────────────────────────────────

const UNDETECTED_CAT_OPTIONS = [
  { value: 'allowances', label: 'Allowance' },
  { value: 'deductions', label: 'Deduction' },
  { value: 'earnings',   label: 'Earning'   },
  { value: 'identity',   label: 'Identity'  },
  { value: 'other',      label: 'Other'     },
];

function UndetectedColumnsPanel({ rows, onChange, onAddToAudit, onSaveToConfig, saving }) {
  if (!rows || rows.length === 0) return null;

  const anySelected = rows.some(r => r.include);

  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50/60 p-4 space-y-3">
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold text-amber-900">
            Undetected Columns ({rows.length})
          </h3>
          <p className="text-xs text-amber-700 mt-0.5">
            These columns were not automatically recognized. Select and classify the ones you
            want to include in the audit, then add them or save to config for future auto-detection.
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            disabled={!anySelected}
            onClick={onAddToAudit}
            className="btn btn-secondary text-xs disabled:opacity-40"
          >
            Add selected to audit
          </button>
          <button
            type="button"
            disabled={!anySelected || saving}
            onClick={onSaveToConfig}
            className="btn btn-primary text-xs disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save selected to config'}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-amber-200 overflow-hidden bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-amber-50 border-b border-amber-200">
              <th className="px-3 py-2 w-8">
                <input
                  type="checkbox"
                  title="Select all"
                  checked={rows.length > 0 && rows.every(r => r.include)}
                  onChange={e => rows.forEach((_, i) => onChange(i, 'include', e.target.checked))}
                  className="rounded border-slate-300"
                />
              </th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-amber-700 uppercase tracking-wide">File 1 Column</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-amber-700 uppercase tracking-wide hidden sm:table-cell">File 2 Column</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-amber-700 uppercase tracking-wide">Label</th>
              <th className="text-left px-3 py-2 text-xs font-semibold text-amber-700 uppercase tracking-wide">Category</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={`border-b border-amber-100 last:border-0 ${row.include ? 'bg-amber-50/40' : 'hover:bg-slate-50/40'}`}>
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={row.include}
                    onChange={e => onChange(i, 'include', e.target.checked)}
                    className="rounded border-slate-300"
                  />
                </td>
                <td className="px-3 py-2 text-xs text-slate-700 font-medium">{row.col1 || <span className="text-slate-400 italic">—</span>}</td>
                <td className="px-3 py-2 text-xs text-slate-500 hidden sm:table-cell">
                  <input
                    type="text"
                    value={row.col2}
                    onChange={e => onChange(i, 'col2', e.target.value)}
                    placeholder="File 2 column name"
                    className="input text-xs py-0.5 w-full"
                  />
                </td>
                <td className="px-3 py-2">
                  <input
                    type="text"
                    value={row.label}
                    onChange={e => onChange(i, 'label', e.target.value)}
                    className="input text-xs py-0.5 w-full"
                  />
                </td>
                <td className="px-3 py-2">
                  <select
                    value={row.category}
                    onChange={e => onChange(i, 'category', e.target.value)}
                    className={`text-xs font-medium rounded-full px-2 py-0.5 border-0 outline-none cursor-pointer ${CAT_PILL[row.category] || CAT_PILL.auto} appearance-none pr-5`}
                    style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\'%3E%3Cpath fill=\'%23888\' d=\'M0 0l5 6 5-6z\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 0.35rem center' }}
                  >
                    {UNDETECTED_CAT_OPTIONS.map(opt => (
                      <option key={opt.value} value={opt.value}>{opt.label}</option>
                    ))}
                  </select>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Column Definitions Manager modal ─────────────────────────────────────────

function ColumnDefsManagerModal({ entries, onClose, onSaveEntry, onReplaceAll }) {
  const [localEntries, setLocalEntries] = useState(() =>
    (entries || []).map(e => ({ ...e, _aliasText: (e.aliases || []).join(', ') }))
  );
  const [newEntry, setNewEntry] = useState({ label: '', aliases: '', category: 'allowances', type: 'currency' });
  const [saving, setSaving] = useState(false);

  function updateLocal(i, field, value) {
    setLocalEntries(prev => prev.map((e, idx) => idx === i ? { ...e, [field]: value } : e));
  }

  async function handleSaveAll() {
    setSaving(true);
    try {
      const cleaned = localEntries.map(e => ({
        label:    e.label,
        aliases:  e._aliasText.split(',').map(a => a.trim()).filter(Boolean),
        category: e.category,
        type:     e.type || 'currency',
      }));
      await onReplaceAll({ version: '1.0', entries: cleaned });
      toast.success('Column definitions saved');
      onClose();
    } catch {
      toast.error('Failed to save definitions');
    } finally {
      setSaving(false);
    }
  }

  async function handleAddNew() {
    if (!newEntry.label.trim()) { toast.error('Label is required'); return; }
    setSaving(true);
    try {
      await onSaveEntry({
        label:    newEntry.label.trim(),
        aliases:  newEntry.aliases.split(',').map(a => a.trim()).filter(Boolean),
        category: newEntry.category,
        type:     newEntry.type,
      });
      setLocalEntries(prev => [
        ...prev,
        { label: newEntry.label.trim(), _aliasText: newEntry.aliases, category: newEntry.category, type: newEntry.type },
      ]);
      setNewEntry({ label: '', aliases: '', category: 'allowances', type: 'currency' });
      toast.success('Entry added');
    } catch {
      toast.error('Failed to add entry');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-16 px-4 bg-black/40" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-4xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Column Definitions</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Edit aliases and categories for any column. Changes are saved to <code className="bg-slate-100 px-1 rounded">column_definitions.json</code>.
            </p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-xl leading-none">✕</button>
        </div>

        {/* Table */}
        <div className="overflow-y-auto flex-1 p-4 space-y-4">
          {/* Add new */}
          <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4 space-y-3">
            <p className="text-xs font-semibold text-emerald-700 uppercase tracking-wide">Add New Entry</p>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
              <input
                type="text" placeholder="Label" value={newEntry.label}
                onChange={e => setNewEntry(p => ({ ...p, label: e.target.value }))}
                className="input text-xs"
              />
              <input
                type="text" placeholder="Aliases (comma separated)" value={newEntry.aliases}
                onChange={e => setNewEntry(p => ({ ...p, aliases: e.target.value }))}
                className="input text-xs sm:col-span-2"
              />
              <select
                value={newEntry.category}
                onChange={e => setNewEntry(p => ({ ...p, category: e.target.value }))}
                className="input text-xs"
              >
                {UNDETECTED_CAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <button type="button" onClick={handleAddNew} disabled={saving} className="btn btn-primary text-xs">Add entry</button>
          </div>

          {/* Existing entries */}
          <div className="rounded-xl border border-slate-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide w-40">Label</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide">Aliases (comma separated)</th>
                  <th className="text-left px-3 py-2 font-semibold text-slate-500 uppercase tracking-wide w-28">Category</th>
                </tr>
              </thead>
              <tbody>
                {localEntries.map((e, i) => (
                  <tr key={i} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50">
                    <td className="px-3 py-1.5">
                      <input type="text" value={e.label} onChange={ev => updateLocal(i, 'label', ev.target.value)} className="input text-xs py-0.5 w-full" />
                    </td>
                    <td className="px-3 py-1.5">
                      <input type="text" value={e._aliasText} onChange={ev => updateLocal(i, '_aliasText', ev.target.value)} className="input text-xs py-0.5 w-full" />
                    </td>
                    <td className="px-3 py-1.5">
                      <select value={e.category} onChange={ev => updateLocal(i, 'category', ev.target.value)} className="input text-xs py-0.5 w-full">
                        {UNDETECTED_CAT_OPTIONS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3 border-t border-slate-200 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">Cancel</button>
          <button type="button" onClick={handleSaveAll} disabled={saving} className="btn btn-primary text-xs">
            {saving ? 'Saving…' : 'Save all changes'}
          </button>
        </div>
      </div>
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
  const [showColumnClassification, setShowColumnClassification] = useState(false);
  const [reconFilter, setReconFilter] = useState('open'); // 'all' | 'open' | 'approved' | 'rejected' | 'ignored'
  const [reconSearch, setReconSearch] = useState('');
  const [reconTypeFilter, setReconTypeFilter] = useState('all');
  const [reconPage, setReconPage] = useState(1);
  const [reconPageSize, setReconPageSize] = useState(50);
  const [loadingBulk, setLoadingBulk] = useState(false);

  // Column definitions state
  const [mergedCatalog,     setMergedCatalog]     = useState(PAYROLL_FIELD_CATALOG);
  const [apiColDefs,        setApiColDefs]        = useState([]);
  const [showColDefsManager,setShowColDefsManager] = useState(false);
  const [undetectedCols,    setUndetectedCols]    = useState([]);
  const [savingColDef,      setSavingColDef]      = useState(false);

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

  useEffect(() => {
    loadFiles();
    loadColumnDefinitions();
  }, []);

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
      const mappings = inferPayrollMappingsForType(file1Columns, file2Columns, auditType, mergedCatalog);
      setAuditMappings(mappings);
      setUndetectedCols(computeUndetectedColumns(
        file1Columns, file2Columns, mappings,
        matchOptions.idCol1, matchOptions.idCol2,
        matchOptions.nameCol1, matchOptions.nameCol2,
      ));
      setResult(null);
      setReconciliationRun(null);
    } else {
      const pairKey = `${file1}|${file2}`;
      if (mappingFilePair.current === pairKey) return;
      mappingFilePair.current = pairKey;
      setColumnMappings([createEmptyMapping()]);
      setResult(null);
      setReconciliationRun(null);
    }
  }, [file1, file2, file1Columns, file2Columns, auditType, mode, mergedCatalog]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (mode !== 'audit' || file1Columns.length === 0 || file2Columns.length === 0) return;
    const mappings = inferPayrollMappingsForType(file1Columns, file2Columns, auditType, mergedCatalog);
    setAuditMappings(mappings);
    setUndetectedCols(computeUndetectedColumns(
      file1Columns, file2Columns, mappings,
      matchOptions.idCol1, matchOptions.idCol2,
      matchOptions.nameCol1, matchOptions.nameCol2,
    ));
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

  async function loadColumnDefinitions() {
    try {
      const data = await getColumnDefinitions();
      const entries = data.entries || [];
      setApiColDefs(entries);
      const catalog = buildMergedCatalog(entries);
      setMergedCatalog(catalog);
      // Reset pair key so mappings regenerate with the enriched catalog
      mappingFilePair.current = '';
    } catch {
      // Non-fatal: fall back to base catalog silently
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

  function handleUndetectedColChange(index, field, value) {
    setUndetectedCols(prev => prev.map((r, i) => i === index ? { ...r, [field]: value } : r));
  }

  function handleAddUndetectedToAudit() {
    const selected = undetectedCols.filter(r => r.include && r.col1 && r.col2);
    if (selected.length === 0) {
      toast.error('Select rows with both file columns filled in to add them');
      return;
    }
    const newMappings = selected.map(r => ({
      file1:    r.col1,
      file2:    r.col2,
      label:    r.label || r.col1,
      type:     'currency',
      category: r.category,
    }));
    setAuditMappings(prev => [...prev, ...newMappings]);
    // Remove the added rows from undetected list
    const addedCol1s = new Set(selected.map(r => r.col1));
    setUndetectedCols(prev => prev.filter(r => !addedCol1s.has(r.col1)));
    toast.success(`Added ${newMappings.length} column(s) to the audit`);
  }

  async function handleSaveUndetectedToConfig() {
    const selected = undetectedCols.filter(r => r.include);
    if (selected.length === 0) { toast.error('Select at least one row to save'); return; }
    setSavingColDef(true);
    try {
      for (const row of selected) {
        if (!row.label.trim()) continue;
        const aliases = [row.col1, row.col2, row.label]
          .filter(Boolean)
          .map(s => s.toLowerCase().trim())
          .filter((v, i, a) => a.indexOf(v) === i);
        await addColumnDefinitionEntry({ label: row.label, aliases, category: row.category, type: 'currency' });
      }
      toast.success(`Saved ${selected.length} column definition(s). Future uploads will auto-detect these columns.`);
      // Reload catalog so new entries are used from now on
      await loadColumnDefinitions();
    } catch {
      toast.error('Failed to save some column definitions');
    } finally {
      setSavingColDef(false);
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

    // Build column_roles map from manual overrides (excludes 'auto')
    const column_roles = {};
    activeMappings.forEach(m => {
      if (m.category && m.category !== 'auto' && m.label) {
        column_roles[m.label] = m.category;
      }
    });

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
        column_roles:    Object.keys(column_roles).length > 0 ? column_roles : null,
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

  function handleCategoryOverride(mappingIndex, category) {
    setAuditMappings(prev => prev.map((m, i) =>
      i === mappingIndex ? { ...m, category } : m
    ));
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

  const previewColumns = useMemo(() => {
    const fileAName = selectedFileNames.fileA || 'File 1';
    const fileBName = selectedFileNames.fileB || 'File 2';

    return [
      {
        accessorKey: 'employee_id',
        header: 'Employee ID',
        cell: ({ row }) => {
          const empId = row.original.employee_id || row.original.file1_id || row.original.file2_id;
          const name = row.original.file1_name || row.original.file2_name;
          return (
            <div className="py-1">
              <div className="font-semibold text-slate-900 text-xs">{empId}</div>
              {name && <div className="text-[10px] text-slate-500 font-medium truncate max-w-[150px]">{name}</div>}
            </div>
          );
        }
      },
      {
        accessorKey: 'field',
        header: 'Field / Column',
        cell: ({ row }) => {
          const field = row.original.field || '—';
          const col1 = row.original.file1_column;
          const col2 = row.original.file2_column;
          return (
            <div className="py-1">
              <div className="font-medium text-slate-800 text-xs">{field}</div>
              {(col1 || col2) && (
                <div className="text-[10px] text-slate-400 font-mono mt-0.5 flex flex-wrap items-center gap-1">
                  {col1 && <span className="bg-slate-100 px-1 py-0.5 rounded border border-slate-200/60">{col1}</span>}
                  {col1 && col2 && col1 !== col2 && <span className="text-slate-300">→</span>}
                  {col2 && col1 !== col2 && <span className="bg-slate-100 px-1 py-0.5 rounded border border-slate-200/60">{col2}</span>}
                </div>
              )}
            </div>
          );
        }
      },
      {
        accessorKey: 'file1_value',
        header: `Value in ${fileAName}`,
        cell: ({ row }) => {
          const val = row.original.file1_value;
          const isNum = row.original.comparison_type === 'currency' || row.original.comparison_type === 'number';
          if (val === null || val === undefined) return <span className="text-slate-400 italic text-xs">—</span>;
          return (
            <div className="px-2.5 py-1 bg-slate-50 border border-slate-200/60 rounded-lg font-mono text-xs text-slate-700 min-w-[100px] text-right shadow-sm inline-block">
              {isNum ? formatCurrency(val) : String(val)}
            </div>
          );
        }
      },
      {
        accessorKey: 'file2_value',
        header: `Value in ${fileBName}`,
        cell: ({ row }) => {
          const val = row.original.file2_value;
          const isNum = row.original.comparison_type === 'currency' || row.original.comparison_type === 'number';
          if (val === null || val === undefined) return <span className="text-slate-400 italic text-xs">—</span>;
          return (
            <div className="px-2.5 py-1 bg-indigo-50/50 border border-indigo-100 rounded-lg font-mono text-xs text-indigo-900 min-w-[100px] text-right shadow-sm inline-block">
              {isNum ? formatCurrency(val) : String(val)}
            </div>
          );
        }
      },
      {
        accessorKey: 'difference',
        header: 'Difference',
        cell: ({ row }) => {
          const val1 = row.original.file1_value;
          const val2 = row.original.file2_value;
          
          let num1 = parseFloat(String(val1).replace(/,/g, '').replace(/[^\d.-]/g, ''));
          let num2 = parseFloat(String(val2).replace(/,/g, '').replace(/[^\d.-]/g, ''));
          
          if (isNaN(num1) || isNaN(num2)) {
            return <span className="text-slate-400 text-xs italic">N/A (Text)</span>;
          }
          
          const diff = num2 - num1;
          const isPos = diff > 0;
          const isZero = Math.abs(diff) < 0.0001;
          
          const colorClass = isZero ? 'text-slate-500' : isPos ? 'text-emerald-600 font-semibold' : 'text-rose-600 font-semibold';
          const bgClass = isZero ? 'bg-slate-50' : isPos ? 'bg-emerald-50/50' : 'bg-rose-50/50';
          const borderClass = isZero ? 'border-slate-200/60' : isPos ? 'border-emerald-100' : 'border-rose-100';
          
          return (
            <div className={`px-2.5 py-1 ${bgClass} border ${borderClass} rounded-lg font-mono text-xs ${colorClass} min-w-[85px] text-right shadow-sm inline-block`}>
              {isZero ? '0.00' : `${isPos ? '+' : ''}${formatCurrency(diff)}`}
            </div>
          );
        }
      }
    ];
  }, [selectedFileNames]);

  const filteredIssues = useMemo(() => {
    let list = reconciliationRun?.issues || [];
    if (reconFilter !== 'all') {
      list = list.filter(i => i.status === reconFilter);
    }
    if (reconTypeFilter !== 'all') {
      list = list.filter(i => i.issue_type === reconTypeFilter);
    }
    if (reconSearch.trim()) {
      const q = reconSearch.toLowerCase().trim();
      list = list.filter(i => 
        (i.employee_id && String(i.employee_id).toLowerCase().includes(q)) ||
        (i.employee_name && String(i.employee_name).toLowerCase().includes(q)) ||
        (i.field && String(i.field).toLowerCase().includes(q)) ||
        (i.issue_type && String(i.issue_type).toLowerCase().replaceAll('_', ' ').includes(q))
      );
    }
    return list;
  }, [reconciliationRun, reconFilter, reconTypeFilter, reconSearch]);

  const visibleReconciliationIssues = useMemo(() => {
    const start = (reconPage - 1) * reconPageSize;
    return filteredIssues.slice(start, start + reconPageSize);
  }, [filteredIssues, reconPage, reconPageSize]);

  async function handleBulkAction(action) {
    const runId = reconciliationRun?.id;
    if (!runId || filteredIssues.length === 0) return;
    
    const confirmMsg = `Are you sure you want to ${action} all ${filteredIssues.length} filtered issues?`;
    if (!window.confirm(confirmMsg)) return;

    setLoadingBulk(true);
    try {
      const issueIds = filteredIssues.map(i => i.id);
      const run = await applyBulkReconciliationAction(runId, issueIds, action);
      setReconciliationRun(run);
      setReconciliationExport(null);
      setReconPage(1);
      toast.success(`Successfully applied ${action} action to ${issueIds.length} issue(s)`);
    } catch (error) {
      toast.error(error?.response?.data?.detail || `Failed to apply action to issues`);
    } finally {
      setLoadingBulk(false);
    }
  }

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
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div>
                <h2 className="text-sm font-semibold text-slate-900">Audit Type</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  Choose what area of the payroll to focus on. Fields are auto-detected from your files.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setShowColDefsManager(true)}
                className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1 border border-blue-200 rounded-lg px-3 py-1.5 bg-blue-50 hover:bg-blue-100 transition-colors"
              >
                ⚙ Manage Column Definitions
              </button>
            </div>

            <AuditTypeSelector value={auditType} onChange={setAuditType} />

            {/* Auto-detected fields preview */}
            {auditMappings.length > 0 && (
              <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 space-y-3">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest">
                    Auto-detected fields ({auditMappings.length})
                  </p>
                  <button
                    type="button"
                    onClick={() => setShowColumnClassification(s => !s)}
                    className="text-xs text-blue-600 hover:text-blue-800 font-medium flex items-center gap-1"
                  >
                    {showColumnClassification ? '▾ Hide' : '▸ Classify columns'}
                  </button>
                </div>
                {!showColumnClassification && (
                  <div className="flex flex-wrap gap-2">
                    {auditMappings.map((m, i) => (
                      <span
                        key={i}
                        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium ${CAT_PILL[m.category] || CAT_PILL.auto} border-transparent`}
                      >
                        {m.label || m.file1}
                        {m.file1 !== m.file2 && <span className="opacity-60 font-normal ml-1">{m.file1} → {m.file2}</span>}
                      </span>
                    ))}
                  </div>
                )}
                {showColumnClassification && (
                  <ColumnClassificationPanel
                    mappings={auditMappings}
                    onChangeCategoryOverride={handleCategoryOverride}
                  />
                )}
              </div>
            )}
            {auditMappings.length === 0 && file1 && file2 && file1Columns.length > 0 && file2Columns.length > 0 && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
                No matching fields found for this audit type. Try a different audit type or different files.
              </div>
            )}

            {/* Undetected columns panel */}
            {mode === 'audit' && undetectedCols.length > 0 && (
              <UndetectedColumnsPanel
                rows={undetectedCols}
                onChange={handleUndetectedColChange}
                onAddToAudit={handleAddUndetectedToAudit}
                onSaveToConfig={handleSaveUndetectedToConfig}
                saving={savingColDef}
              />
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
                + Add column pair
              </button>
              <button
                type="button"
                onClick={() => {
                  const inferred = inferPayrollMappingsForType(file1Columns, file2Columns, 'full', mergedCatalog);
                  if (inferred.length > 0) {
                    setColumnMappings(inferred);
                    toast.success(`Auto-detected ${inferred.length} column pair(s)`);
                  } else {
                    toast.error('No matching columns could be auto-detected');
                  }
                }}
                disabled={!file1 || !file2}
                className="btn btn-secondary text-xs text-blue-600 hover:text-blue-800 hover:bg-blue-50 border-blue-200 disabled:opacity-40 disabled:hover:bg-transparent"
              >
                Auto-detect column pairs
              </button>
              <button
                type="button"
                onClick={() => {
                  setColumnMappings([createEmptyMapping()]);
                  toast.success('Column pairs cleared');
                }}
                className="btn btn-secondary text-xs text-rose-600 hover:text-rose-800 hover:bg-rose-50 border-rose-200"
              >
                Clear all
              </button>
              <button onClick={handleRun} disabled={loading || !canRun} className="btn btn-primary text-xs">
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
                  {/* Workbench Title Header */}
                  <div className="p-5 flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div>
                      <h2 className="text-sm font-semibold text-slate-900">Reconciliation Review Workbench</h2>
                      <p className="text-xs text-slate-500 mt-1">
                        Approve valid HR changes, reject incorrect differences, or ignore items that do not need action.
                      </p>
                    </div>
                    <div className="flex flex-wrap gap-2.5 items-center">
                      {/* Status filter tabs */}
                      <div className="flex rounded-lg border border-slate-200 overflow-hidden bg-slate-50 p-0.5 text-xs font-medium">
                        {['all', 'open', 'approved', 'rejected', 'ignored'].map(status => {
                          const count = status === 'all'
                            ? (reconciliationRun.issues || []).length
                            : (reconciliationRun.status_counts?.[status] || 0);
                          
                          const isActive = reconFilter === status;
                          return (
                            <button
                              key={status}
                              type="button"
                              onClick={() => { setReconFilter(status); setReconPage(1); }}
                              className={`px-2.5 py-1 rounded transition-all capitalize ${
                                isActive
                                  ? 'bg-white text-slate-900 shadow-sm border border-slate-200/40'
                                  : 'text-slate-500 hover:text-slate-700 hover:bg-white/40'
                              }`}
                            >
                              {status} ({count})
                            </button>
                          );
                        })}
                      </div>

                      <button
                        onClick={handleExportApprovedUpdates}
                        disabled={exportingReconciliation || approvedIssueCount === 0}
                        className="btn btn-primary text-xs disabled:opacity-40"
                      >
                        {exportingReconciliation ? 'Exporting…' : 'Export Approved HR Updates'}
                      </button>
                    </div>
                  </div>

                  {/* Search and Filters row */}
                  <div className="px-5 py-3 bg-slate-50/50 flex flex-wrap items-center justify-between gap-3">
                    <div className="flex flex-wrap gap-2 items-center flex-1">
                      {/* Search Bar */}
                      <input
                        type="text"
                        placeholder="Search Employee ID, Name, Field or Issue..."
                        value={reconSearch}
                        onChange={e => { setReconSearch(e.target.value); setReconPage(1); }}
                        className="input text-xs w-full sm:w-64 py-1.5"
                      />
                      
                      {/* Issue Type Select */}
                      <select
                        value={reconTypeFilter}
                        onChange={e => { setReconTypeFilter(e.target.value); setReconPage(1); }}
                        className="input text-xs w-full sm:w-52 py-1.5"
                      >
                        <option value="all">All Issue Types</option>
                        <option value="salary_change">Salary Changes</option>
                        <option value="rank_change">Rank / Grade Changes</option>
                        <option value="branch_change">Branch Changes</option>
                        <option value="potential_new_hire">New Hires</option>
                        <option value="potential_resignation">Resignations</option>
                        <option value="allowance_or_deduction_change">Allowance / Deduction Changes</option>
                        <option value="field_mismatch">Other Field Mismatches</option>
                      </select>
                    </div>

                    <div className="text-xs text-slate-500 font-semibold">
                      Found {filteredIssues.length} matching issues
                    </div>
                  </div>

                  {/* Bulk Action panel */}
                  {filteredIssues.length > 0 && (
                    <div className="bg-blue-50/50 px-5 py-3 flex flex-wrap items-center justify-between gap-3">
                      <div className="text-xs font-semibold text-blue-900 flex items-center gap-1.5">
                        <span className="inline-block w-2 h-2 rounded-full bg-blue-500 animate-pulse" />
                        Bulk Action on {filteredIssues.length} Filtered Issue(s) ({reconFilter !== 'all' ? reconFilter : 'all'} status):
                      </div>
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          onClick={() => handleBulkAction('approve')}
                          disabled={loadingBulk || filteredIssues.every(i => i.status === 'approved')}
                          className="text-xs px-2.5 py-1.5 rounded-lg border font-semibold bg-emerald-600 hover:bg-emerald-700 border-emerald-600 text-white disabled:opacity-40 transition-colors shadow-sm"
                        >
                          {loadingBulk ? 'Processing…' : 'Approve All'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleBulkAction('reject')}
                          disabled={loadingBulk || filteredIssues.every(i => i.status === 'rejected')}
                          className="text-xs px-2.5 py-1.5 rounded-lg border font-semibold bg-rose-600 hover:bg-rose-700 border-rose-600 text-white disabled:opacity-40 transition-colors shadow-sm"
                        >
                          {loadingBulk ? 'Processing…' : 'Reject All'}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleBulkAction('ignore')}
                          disabled={loadingBulk || filteredIssues.every(i => i.status === 'ignored')}
                          className="text-xs px-2.5 py-1.5 rounded-lg border font-semibold bg-slate-600 hover:bg-slate-700 border-slate-600 text-white disabled:opacity-40 transition-colors shadow-sm"
                        >
                          {loadingBulk ? 'Processing…' : 'Ignore All'}
                        </button>
                        {reconFilter !== 'open' && (
                          <button
                            type="button"
                            onClick={() => handleBulkAction('reopen')}
                            disabled={loadingBulk || filteredIssues.every(i => i.status === 'open')}
                            className="text-xs px-2.5 py-1.5 rounded-lg border font-semibold bg-blue-600 hover:bg-blue-700 border-blue-600 text-white disabled:opacity-40 transition-colors shadow-sm"
                          >
                            {loadingBulk ? 'Processing…' : 'Reopen All'}
                          </button>
                        )}
                      </div>
                    </div>
                  )}

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
                          <th>{reconciliationRun.file1_label || 'Original Value'}</th>
                          <th>{reconciliationRun.file2_label || 'New Value'}</th>
                          <th>Difference</th>
                          <th>Reason</th>
                          <th>Actions</th>
                        </tr>
                      </thead>
                      <tbody>
                        {visibleReconciliationIssues.map(issue => {
                          const isNumeric = issue.old_value !== null && issue.new_value !== null && 
                            !isNaN(parseFloat(String(issue.old_value).replace(/,/g, ''))) && 
                            !isNaN(parseFloat(String(issue.new_value).replace(/,/g, '')));
                          
                          const diff = issue.difference;
                          const isPos = diff > 0;
                          const isZero = diff !== null && Math.abs(diff) < 0.0001;
                          
                          const colorClass = isZero ? 'text-slate-500' : isPos ? 'text-emerald-600 font-semibold' : 'text-rose-600 font-semibold';
                          const bgClass = isZero ? 'bg-slate-50' : isPos ? 'bg-emerald-50/50' : 'bg-rose-50/50';
                          const borderClass = isZero ? 'border-slate-200/60' : isPos ? 'border-emerald-100' : 'border-rose-100';

                          let statusBadgeClass = 'inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold border ';
                          if (issue.status === 'approved') statusBadgeClass += 'bg-emerald-100 border-emerald-200 text-emerald-800';
                          else if (issue.status === 'open') statusBadgeClass += 'bg-blue-100 border-blue-200 text-blue-800';
                          else if (issue.status === 'rejected') statusBadgeClass += 'bg-rose-100 border-rose-200 text-rose-800';
                          else statusBadgeClass += 'bg-slate-100 border-slate-200 text-slate-700';

                          return (
                            <tr key={issue.id}>
                              <td>
                                <span className={statusBadgeClass}>
                                  {issue.status}
                                </span>
                              </td>
                              <td>
                                <div className="font-semibold text-slate-800 text-xs">{issue.issue_type.replaceAll('_', ' ')}</div>
                                <div className="text-[10px] text-slate-400 font-medium mt-0.5">{Math.round((issue.confidence || 0) * 100)}% confidence</div>
                              </td>
                              <td>
                                <div className="text-xs font-semibold text-slate-900">{issue.employee_id || '-'}</div>
                                {issue.employee_name && <div className="text-[10px] text-slate-500 font-medium truncate max-w-[120px]" title={issue.employee_name}>{issue.employee_name}</div>}
                              </td>
                              <td className="text-xs font-medium text-slate-700">{issue.field || '-'}</td>
                              <td>
                                <div className="px-2 py-0.5 bg-slate-50 border border-slate-200/60 rounded-md font-mono text-[11px] text-slate-700 min-w-[70px] text-right shadow-sm inline-block">
                                  {isNumeric ? formatCurrency(issue.old_value) : (issue.old_value ?? '-')}
                                </div>
                              </td>
                              <td>
                                <div className="px-2 py-0.5 bg-indigo-50/50 border border-indigo-100 rounded-md font-mono text-[11px] text-indigo-900 min-w-[70px] text-right shadow-sm inline-block">
                                  {isNumeric ? formatCurrency(issue.new_value) : (issue.new_value ?? '-')}
                                </div>
                              </td>
                              <td>
                                {isNumeric && diff !== null ? (
                                  <div className={`px-2 py-0.5 ${bgClass} border ${borderClass} rounded-md font-mono text-[11px] ${colorClass} min-w-[65px] text-right shadow-sm inline-block`}>
                                    {isZero ? '0.00' : `${isPos ? '+' : ''}${formatCurrency(diff)}`}
                                  </div>
                                ) : (
                                  <span className="text-slate-400 text-[10px] italic font-medium">Text change</span>
                                )}
                              </td>
                              <td>
                                <div className="max-w-[200px] text-[11px] text-slate-700 leading-relaxed font-medium">{issue.explanation}</div>
                                <div className="text-[10px] text-slate-400 mt-1 italic">{issue.suggested_action}</div>
                              </td>
                              <td>
                                <div className="flex flex-wrap gap-1">
                                  {issue.status !== 'approved' && (
                                    <button
                                      onClick={() => handleReconciliationAction(issue.id, 'approve')}
                                      disabled={reconciliationActionId === issue.id}
                                      className="text-[11px] px-2 py-1 rounded border font-semibold bg-emerald-50 hover:bg-emerald-100/80 border-emerald-200 text-emerald-700 disabled:opacity-40 transition-colors shadow-sm"
                                    >
                                      Approve
                                    </button>
                                  )}
                                  {issue.status !== 'rejected' && (
                                    <button
                                      onClick={() => handleReconciliationAction(issue.id, 'reject')}
                                      disabled={reconciliationActionId === issue.id}
                                      className="text-[11px] px-2 py-1 rounded border font-semibold bg-rose-50 hover:bg-rose-100/80 border-rose-200 text-rose-700 disabled:opacity-40 transition-colors shadow-sm"
                                    >
                                      Reject
                                    </button>
                                  )}
                                  {issue.status !== 'ignored' && (
                                    <button
                                      onClick={() => handleReconciliationAction(issue.id, 'ignore')}
                                      disabled={reconciliationActionId === issue.id}
                                      className="text-[11px] px-2 py-1 rounded border font-semibold bg-slate-50 hover:bg-slate-100/80 border-slate-200 text-slate-600 disabled:opacity-40 transition-colors shadow-sm"
                                    >
                                      Ignore
                                    </button>
                                  )}
                                  {issue.status !== 'open' && (
                                    <button
                                      onClick={() => handleReconciliationAction(issue.id, 'reopen')}
                                      disabled={reconciliationActionId === issue.id}
                                      className="text-[11px] px-2 py-1 rounded border font-semibold bg-blue-50 hover:bg-blue-100/80 border-blue-200 text-blue-700 disabled:opacity-40 transition-colors shadow-sm"
                                    >
                                      Reopen
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {visibleReconciliationIssues.length === 0 && (
                          <tr><td colSpan={9} className="text-center py-6 text-sm text-slate-500">No reconciliation issues found.</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Pagination footer */}
                  {filteredIssues.length > 0 && (
                    <div className="px-5 py-3 flex flex-wrap items-center justify-between gap-2 text-xs border-t border-slate-100 bg-slate-50/50 font-medium">
                      <div className="text-slate-500">
                        Showing {((reconPage - 1) * reconPageSize) + 1}–{Math.min(reconPage * reconPageSize, filteredIssues.length)} of {filteredIssues.length} issue(s)
                        {filteredIssues.length < (reconciliationRun.issues || []).length && ` (filtered from ${(reconciliationRun.issues || []).length} total)`}
                      </div>
                      
                      {/* Pagination Controls */}
                      {Math.ceil(filteredIssues.length / reconPageSize) > 1 && (
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={reconPage === 1}
                            onClick={() => setReconPage(1)}
                            className="px-2 py-1 border rounded hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent"
                          >
                            « First
                          </button>
                          <button
                            type="button"
                            disabled={reconPage === 1}
                            onClick={() => setReconPage(p => Math.max(1, p - 1))}
                            className="px-2 py-1 border rounded hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent"
                          >
                            ‹ Prev
                          </button>
                          <span className="text-slate-600 px-1">
                            Page {reconPage} of {Math.ceil(filteredIssues.length / reconPageSize)}
                          </span>
                          <button
                            type="button"
                            disabled={reconPage === Math.ceil(filteredIssues.length / reconPageSize)}
                            onClick={() => setReconPage(p => Math.min(Math.ceil(filteredIssues.length / reconPageSize), p + 1))}
                            className="px-2 py-1 border rounded hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent"
                          >
                            Next ›
                          </button>
                          <button
                            type="button"
                            disabled={reconPage === Math.ceil(filteredIssues.length / reconPageSize)}
                            onClick={() => setReconPage(Math.ceil(filteredIssues.length / reconPageSize))}
                            className="px-2 py-1 border rounded hover:bg-slate-100 disabled:opacity-40 disabled:hover:bg-transparent"
                          >
                            Last »
                          </button>
                        </div>
                      )}
                    </div>
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
            <DataTable data={result.preview_differences || []} columns={previewColumns} allowHorizontalScroll={true} />
          </div>
        </div>
      )}

      {/* ── Column Definitions Manager modal ───────────────────────────────── */}
      {showColDefsManager && (
        <ColumnDefsManagerModal
          entries={apiColDefs}
          onClose={() => setShowColDefsManager(false)}
          onSaveEntry={addColumnDefinitionEntry}
          onReplaceAll={async (defs) => {
            await replaceColumnDefinitions(defs);
            await loadColumnDefinitions();
          }}
        />
      )}
    </div>
  );
}
