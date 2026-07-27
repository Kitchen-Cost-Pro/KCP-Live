export const SCHEDULE_EXPORT_FORMATS = Object.freeze(['csv', 'xlsx', 'pdf', 'report_link']);

const FORMAT_SET = new Set(SCHEDULE_EXPORT_FORMATS);

export function normalizeScheduleExportFormat(value = '', fallback = 'report_link') {
  const normalized = String(value || '').trim().toLowerCase();
  if (FORMAT_SET.has(normalized)) return normalized;
  const normalizedFallback = String(fallback || '').trim().toLowerCase();
  return FORMAT_SET.has(normalizedFallback) ? normalizedFallback : 'report_link';
}
