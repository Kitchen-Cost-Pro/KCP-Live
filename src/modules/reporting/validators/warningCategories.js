import { text } from '../engine/grouping.js';
import { flattenWarnings } from './rowWarningUtils.js';

export const WARNING_CATEGORIES = {
  critical: 'Critical Data Quality Issues',
  coverage: 'Coverage Notes',
  backend: 'Backend Mapping Gaps'
};

export function categorizeReportWarnings(warnings = []) {
  const seen = new Set();
  return flattenWarnings(warnings)
    .map(normalizeWarning)
    .filter((warning) => {
      const key = [warning.category, warning.level, warning.code, warning.message].map(text).join('|');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

export function normalizeWarning(warning = {}) {
  const objectWarning = typeof warning === 'object' && warning !== null ? warning : { message: text(warning) };
  const level = normalizeLevel(objectWarning.level);
  const code = text(objectWarning.code);
  const message = text(objectWarning.message || objectWarning);
  return {
    ...objectWarning,
    code,
    level,
    message,
    category: objectWarning.category || resolveWarningCategory({ code, level, message })
  };
}



export function isUserFixableWarning(warning = {}) {
  const objectWarning = typeof warning === 'object' && warning !== null ? warning : { message: text(warning) };
  const combined = [
    objectWarning.code,
    objectWarning.message,
    objectWarning.issue,
    objectWarning.issueType,
    objectWarning.suggestedFix,
    objectWarning.status,
    objectWarning.recipeStatus,
    objectWarning.area,
    objectWarning.entityType
  ].map(text).join(' ').toLowerCase();

  if (!combined.trim()) return false;
  if (isSystemOwnedReportingWarning(objectWarning)) return false;

  // Customer-visible data quality is an explicit allow-list. These are fields a
  // workspace user can correct in KCP. Provider identifiers, receipts, ledger
  // traceability, webhook state, internal reconciliation, and database/schema
  // notes are owned by the application and must never be presented as customer
  // cleanup work.
  return /\b(missing|no|zero|invalid|incomplete|not ready|not[-_ ]?ready|unmapped)\b.*\b(item|product|menu item|stock item|ingredient)?\s*(name|location|price|selling price|cost|unit cost|recipe|uom|unit of measure|category|supplier)\b/i.test(combined)
    || /\b(name|location|price|selling price|cost|unit cost|recipe|uom|unit of measure|category|supplier)\b.*\b(missing|zero|invalid|incomplete|not ready|not[-_ ]?ready|unmapped)\b/i.test(combined)
    || /\b(low stock|below par|critical stock|reorder|stock alert|par level)\b/i.test(combined)
    || /\b(circular recipe|recipe loop|recipe setup|missing[-_ ]?recipe|missing[-_ ]?unit[-_ ]?cost|missing[-_ ]?cost|missing[-_ ]?price|missing[-_ ]?location[-_ ]?name|missing[-_ ]?item[-_ ]?name|missing[-_ ]?uom)\b/i.test(combined);
}

export function isSystemOwnedReportingWarning(warning = {}) {
  const objectWarning = typeof warning === 'object' && warning !== null ? warning : { message: text(warning) };
  const combined = [
    objectWarning.code,
    objectWarning.message,
    objectWarning.issue,
    objectWarning.issueType,
    objectWarning.suggestedFix,
    objectWarning.status
  ].map(text).join(' ').toLowerCase();
  if (!combined.trim()) return false;

  return /missing[-_ ]?dates?|date.*may not filter|opening stock snapshots?|actual closing stock snapshots?|stock snapshots? are added|variance.*cannot|expected closing.*reconcile|source ids?|missing source|sale ids?|missing sale|receipt(?: number| id)?|payment method|provider id|yoco .*id|modifier id|webhook|signature|event id|created[_ ]?by|missing user|audit trail|traceability|backend|api|ledger path|source table|data source|database|schema|migration|reconciliation|not present in the selected|no .*selected filters|coverage|accounting-only|sub-recipe double-counting|transfers not separated|manual adjustments missing|manufacturing wastage grouped|movement row.*missing|no movement row|stock movement source|internal|worker/i.test(combined);
}

export function filterUserVisibleWarnings(warnings = []) {
  return flattenWarnings(warnings)
    .map(normalizeWarning)
    .filter(isUserFixableWarning);
}

export function isCustomerActionableQualityRow(row = {}) {
  const objectRow = typeof row === 'object' && row !== null ? row : { issue: text(row) };
  return isUserFixableWarning({
    ...objectRow,
    code: objectRow.code || objectRow.warningCode || objectRow.issueType || objectRow.status,
    message: [
      objectRow.message,
      objectRow.issue,
      objectRow.issueType,
      objectRow.impact,
      objectRow.suggestedFix,
      objectRow.warning,
      objectRow.warningsText,
      objectRow.status,
      objectRow.recipeStatus,
      objectRow.priceStatus,
      objectRow.locationPriceStatus
    ].map(text).filter(Boolean).join(' ')
  });
}

export function filterCustomerActionableQualityRows(rows = []) {
  return (Array.isArray(rows) ? rows : [])
    .filter(isCustomerActionableQualityRow);
}

export function filterCustomerActionableIssueText(value = '') {
  const parts = text(value)
    .split(/;|\n|\|/)
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => isUserFixableWarning({ message: part }));
  return Array.from(new Set(parts)).join('; ');
}

export function resolveWarningCategory({ code = '', level = 'info', message = '' } = {}) {
  const normalized = `${text(code)} ${text(message)}`.toLowerCase();
  if (isCoverageNote(normalized, level)) return WARNING_CATEGORIES.coverage;
  if (isBackendMappingGap(normalized)) return WARNING_CATEGORIES.backend;
  if (['critical', 'error', 'warning'].includes(normalizeLevel(level))) return WARNING_CATEGORIES.critical;
  return WARNING_CATEGORIES.coverage;
}

function normalizeLevel(level = 'info') {
  const normalized = text(level).toLowerCase();
  if (normalized === 'error') return 'critical';
  return normalized || 'info';
}

function isCoverageNote(normalized = '', level = 'info') {
  if (normalizeLevel(level) === 'info') return true;
  return /\b(no|zero)\b.*\b(rows|activity|wastage|transfers|adjustments|stock takes|found|selected period|selected filters)\b/i.test(normalized)
    || /not present in the selected|no .* in the selected|no .* exist|not available for the selected/i.test(normalized)
    || /empty-report|empty$|coverage|advisory|no-source-rows/i.test(normalized);
}

function isBackendMappingGap(normalized = '') {
  return /backend|mapping|api|source table|stock_movements|ledger path|accounting-only|snapshot|data source|unmapped|not mapped/i.test(normalized)
    || /missing .*api|missing .*source table|missing .*ledger/i.test(normalized);
}
