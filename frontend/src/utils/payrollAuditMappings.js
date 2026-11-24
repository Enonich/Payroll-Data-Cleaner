import { findBestColumn, scoreColumnMatch } from './columnMatching.js';

export const PAYROLL_FIELD_CATALOG = [
  { label: 'Name',             aliases: ['name', 'employee name', 'fullname', 'full name'],                                    type: 'text',     category: 'identity'   },
  { label: 'Branch',           aliases: ['branch', 'location', 'office'],                                                      type: 'text',     category: 'identity'   },
  { label: 'Annual Salary',    aliases: ['annual salary', 'annualsalary'],                                                     type: 'currency', category: 'earnings'   },
  { label: 'Basic Salary',     aliases: ['basic salary', 'basicsalary', 'basic', 'monthly salary', 'monthlysalary', 'basic salary (monthly salary)', 'basic salary monthly salary'], type: 'currency', category: 'earnings'   },
  { label: 'Taxable Allowance',aliases: ['taxable allowance', 'taxableallowance', 'taxable allow', 'taxable allow.', 'taxable alloc', 'total allowance', 'totalallowance', 'total allow', 'total alloc'], type: 'currency', category: 'allowances' },
  { label: '5.5% SSF',         aliases: ['5.5% ssf', '55 ssf', '55ssf', 'ssf 5.5', 'ssf5.5', '5.5% ssf employee', 'employee ssf'], type: 'currency', category: 'statutory_deductions' },
  { label: '4.5% Staff PF',    aliases: ['4.5% staff pf', '45staffpf', 'staff pf', 'staffpf', '45 pf', '7.5%pf staff', 'tier 3 provident fund employee', 'pf staff'], type: 'currency', category: 'statutory_deductions' },
  { label: 'Tax Relief',       aliases: ['tax relief', 'taxrelief', 'tax/mortgage relief', 'mortgage relief', 'tax relieve'],  type: 'currency', category: 'statutory_deductions' },
  { label: 'Taxable Salary',   aliases: ['taxable salary', 'taxablesalary', 'taxable pay'],                                   type: 'currency', category: 'earnings'   },
  { label: 'Income Tax',       aliases: ['income tax', 'incometax', 'paye', 'tax', 'paye tax', 'tax deducted', 'p.a.y.e', 'p.a.y.e.', 'payee'], type: 'currency', category: 'statutory_deductions' },
  { label: 'Other Deductions', aliases: ['other deductions', 'otherdeductions'],                                               type: 'currency', category: 'non_statutory_deductions' },
  { label: 'Deductions',       aliases: ['deductions', 'deduction'],                                                           type: 'currency', category: 'deductions' },
  { label: 'Total Deductions', aliases: ['total deductions', 'totaldeductions', 'total deduct'],                               type: 'currency', category: 'deductions' },
  { label: 'Take Home',        aliases: ['take home', 'takehome', 'net pay', 'netpay', 'net sal', 'net salary'],               type: 'currency', category: 'earnings'   },
  { label: '13% SSF',          aliases: ['13% ssf', '13ssf'],                                                                  type: 'currency', category: 'statutory_deductions' },
  { label: '11% PF',           aliases: ['11% pf', '11pf'],                                                                   type: 'currency', category: 'statutory_deductions' },
  { label: '1st Tier (13.5%)', aliases: ['1st tier (13.5%)', '1st tier 13.5', '1sttier135', 'first tier 13.5'],               type: 'currency', category: 'statutory_deductions' },
  { label: '1st Tier (5%)',    aliases: ['1st tier (5%)', '1st tier 5', '1sttier5', 'first tier 5'],                          type: 'currency', category: 'statutory_deductions' },
  { label: '3rd Tier (15.5%)', aliases: ['3rd tier (15.5%)', '3rd tier 15.5', '3rdtier155', 'third tier 15.5'],               type: 'currency', category: 'statutory_deductions' },
];

const DEDUCTION_CATEGORIES = new Set([
  'deductions',
  'statutory_deductions',
  'non_statutory_deductions',
]);

// type: 'full' | 'allowances' | 'deductions'
export function inferPayrollMappingsForType(columns1, columns2, type = 'full', catalog = PAYROLL_FIELD_CATALOG) {
  const used1 = new Set();
  const used2 = new Set();
  const mappings = [];

  const filtered = catalog.filter(field => {
    if (field.label === 'Name') return false;
    if (type === 'full') return field.category !== 'identity';
    if (type === 'allowances') return field.category === 'allowances';
    if (type === 'deductions') return DEDUCTION_CATEGORIES.has(field.category);
    return false;
  });

  for (const field of filtered) {
    const col1 = findBestColumn(columns1, field.aliases, used1, field.type);
    const col2 = findBestColumn(columns2, field.aliases, used2, field.type);
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
export function buildMergedCatalog(apiEntries) {
  const base = PAYROLL_FIELD_CATALOG;
  const baseLabels = new Set(base.map(e => e.label.toLowerCase()));
  const extras = (apiEntries || [])
    .filter(e => !baseLabels.has((e.label || '').toLowerCase()))
    .map(e => ({
      label: e.label,
      aliases: Array.isArray(e.aliases) ? e.aliases : [],
      type: e.type || 'currency',
      category: e.category || 'allowances',
    }));
  return [...base, ...extras];
}

// Find columns in both files that were NOT matched by any catalog entry.
// Returns array of { col1, col2, label, category } objects ready for the user to classify.
export function computeUndetectedColumns(cols1, cols2, currentMappings, idCol1, idCol2, nameCol1, nameCol2) {
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
