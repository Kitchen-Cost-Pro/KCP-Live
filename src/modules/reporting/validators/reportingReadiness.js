import { toArray } from '../engine/grouping.js';

const CRITICAL_CODES = new Set([
  'report-source-incomplete',
  'report-row-count-mismatch',
  'duplicate-report-rows',
  'invalid-report-money-values',
  'report-export-row-count-mismatch',
  'report-export-column-mismatch'
]);

export function calculateReportingReadiness(results = [], options = {}) {
  const reports = toArray(results);
  const allWarnings = reports.flatMap((result) => toArray(result?.allWarnings || result?.warnings));
  const critical = allWarnings.filter((warning) => String(warning?.level || '').toLowerCase() === 'critical');
  const warnings = allWarnings.filter((warning) => String(warning?.level || '').toLowerCase() === 'warning');
  const completenessFailures = critical.filter((warning) => CRITICAL_CODES.has(warning?.code));
  const missingReports = reports.filter((result) => !result?.report || !result?.id);
  const expectedReportCount = Number(options.expectedReportCount || 0);

  let score = 10;
  score -= Math.min(4, completenessFailures.length * 1.5);
  score -= Math.min(3, Math.max(0, critical.length - completenessFailures.length) * 0.75);
  score -= Math.min(1, warnings.length * 0.05);
  score -= Math.min(2, missingReports.length * 0.5);
  if (expectedReportCount && reports.length < expectedReportCount) score -= 2;
  score = Math.max(0, Math.round(score * 10) / 10);

  return {
    score,
    readyForPilot: score >= 9.5 && critical.length === 0 && completenessFailures.length === 0,
    reportCount: reports.length,
    criticalCount: critical.length,
    warningCount: warnings.length,
    completenessFailureCount: completenessFailures.length,
    blockers: critical.map((warning) => ({ code: warning.code, message: warning.message })),
    advisoryWarnings: warnings.map((warning) => ({ code: warning.code, message: warning.message }))
  };
}
