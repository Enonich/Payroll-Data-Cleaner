import test from 'node:test';
import assert from 'node:assert/strict';

import { inferPayrollMappingsForType } from './payrollAuditMappings.js';

const columns = [
  'Employee ID',
  'Basic Salary',
  'Taxable Allowance',
  'Income Tax',
  'Total Deductions',
  'Take Home',
];

test('allowance audit only auto-detects allowance fields', () => {
  const mappings = inferPayrollMappingsForType(columns, columns, 'allowances');

  assert.deepEqual(mappings.map(m => m.label), ['Taxable Allowance']);
  assert.deepEqual([...new Set(mappings.map(m => m.category))], ['allowances']);
});

test('deductions audit only auto-detects deduction fields', () => {
  const mappings = inferPayrollMappingsForType(columns, columns, 'deductions');

  assert.ok(mappings.every(m => m.category.includes('deductions')));
  assert.equal(mappings.some(m => m.category === 'earnings'), false);
  assert.equal(mappings.some(m => m.category === 'allowances'), false);
});

test('full audit keeps earnings, allowances, and deductions', () => {
  const mappings = inferPayrollMappingsForType(columns, columns, 'full');

  assert.ok(mappings.some(m => m.label === 'Basic Salary'));
  assert.ok(mappings.some(m => m.label === 'Taxable Allowance'));
  assert.ok(mappings.some(m => m.category.includes('deductions')));
  assert.ok(mappings.some(m => m.label === 'Take Home'));
});
