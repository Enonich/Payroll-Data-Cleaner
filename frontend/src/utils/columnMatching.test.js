import test from 'node:test';
import assert from 'node:assert/strict';

import { findBestColumn, scoreColumnMatch } from './columnMatching.js';

test('does not map monthly basic salary to an annual basic column', () => {
  const match = findBestColumn(
    ['Annual Basic'],
    ['basic salary', 'basic', 'monthly salary'],
    new Set(),
    'currency',
  );

  assert.equal(match, '');
});

test('does not map an SSNIT identifier to a contribution amount', () => {
  const match = findBestColumn(
    ['SSNIT No.                .1'],
    ['tier 1 ssnit employee'],
    new Set(),
    'currency',
  );

  assert.equal(match, '');
  assert.equal(scoreColumnMatch('SSNIT No. .1', ['tier 1 ssnit employee'], 'currency'), 0);
});

test('still maps a valid SSF contribution column', () => {
  const match = findBestColumn(
    ['SSF (5.5%)'],
    ['5.5% ssf', 'ssf 5.5'],
    new Set(),
    'currency',
  );

  assert.equal(match, 'SSF (5.5%)');
});

test('does not map TAX column to Taxable Allowance', () => {
  const match = findBestColumn(
    ['TAX'],
    ['taxable allowance', 'taxableallowance'],
    new Set(),
    'currency',
  );

  assert.equal(match, '');
  assert.equal(scoreColumnMatch('TAX', ['taxable allowance', 'taxableallowance'], 'currency'), 0);
});

test('correctly maps TAX column to Income Tax', () => {
  const match = findBestColumn(
    ['TAX'],
    ['income tax', 'incometax', 'paye', 'tax'],
    new Set(),
    'currency',
  );

  assert.equal(match, 'TAX');
});