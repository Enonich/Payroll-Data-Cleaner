const IDENTIFIER_TOKENS = new Set(['id', 'identifier', 'number', 'no', 'account']);
const PAY_PERIOD_TOKENS = ['annual', 'monthly'];

export function normalizeHeader(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[%()]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function canonicalHeader(value) {
  return normalizeHeader(value).replace(/\s+/g, '');
}

function headerTokens(value) {
  return normalizeHeader(value).split(' ').filter(Boolean);
}

function hasPayPeriodConflict(columnTokens, aliasTokens) {
  const salaryTokens = new Set(['basic', 'salary', 'pay']);
  const isSalaryField = [...columnTokens, ...aliasTokens].some(token => salaryTokens.has(token));
  if (!isSalaryField) return false;

  return PAY_PERIOD_TOKENS.some(period => columnTokens.includes(period) !== aliasTokens.includes(period));
}

export function scoreColumnMatch(column, aliases, expectedType = '') {
  const normalizedColumn = normalizeHeader(column);
  const canonicalColumn = canonicalHeader(column);
  const columnTokens = headerTokens(column);

  if (expectedType === 'currency' && columnTokens.some(token => IDENTIFIER_TOKENS.has(token))) {
    return 0;
  }

  let score = 0;
  for (const alias of aliases) {
    const normalizedAlias = normalizeHeader(alias);
    const canonicalAlias = canonicalHeader(alias);
    const aliasTokens = headerTokens(alias);

    if (hasPayPeriodConflict(columnTokens, aliasTokens)) continue;

    const hasTokenMatch = columnTokens.some(ct => aliasTokens.includes(ct));
    const hasTokenPrefixMatch = columnTokens.some(ct =>
      ct.length >= 4 && aliasTokens.some(at => at.length >= 4 && (at.startsWith(ct) || ct.startsWith(at)))
    );

    if (canonicalColumn === canonicalAlias) {
      score = Math.max(score, 100);
    } else if (normalizedColumn === normalizedAlias) {
      score = Math.max(score, 95);
    } else if (hasTokenMatch || hasTokenPrefixMatch) {
      const matchedCount = columnTokens.filter(ct =>
        aliasTokens.includes(ct) ||
        (ct.length >= 4 && aliasTokens.some(at => at.length >= 4 && (at.startsWith(ct) || ct.startsWith(at))))
      ).length;

      const maxLen = Math.max(columnTokens.length, aliasTokens.length);
      const coverage = maxLen > 0 ? matchedCount / maxLen : 0;
      const matchScore = Math.round(75 + coverage * 20);
      score = Math.max(score, matchScore);
    } else if (
      canonicalColumn.length >= 5 && canonicalAlias.length >= 5 &&
      (canonicalColumn.includes(canonicalAlias) || canonicalAlias.includes(canonicalColumn))
    ) {
      score = Math.max(score, 60);
    } else {
      const meaningfulAliasTokens = aliasTokens.filter(token => token.length >= 2);
      const matchedTokens = meaningfulAliasTokens.filter(token => columnTokens.includes(token)).length;
      if (matchedTokens > 0) {
        score = Math.max(score, matchedTokens * 20);
      }
    }
  }

  return score;
}

export function findBestColumn(columns, aliases, usedColumns = new Set(), expectedType = '') {
  let bestColumn = '';
  let bestScore = 0;

  for (const column of columns) {
    if (usedColumns.has(column)) continue;
    const score = scoreColumnMatch(column, aliases, expectedType);
    if (score > bestScore) {
      bestScore = score;
      bestColumn = column;
    }
  }

  return bestScore >= 40 ? bestColumn : '';
}