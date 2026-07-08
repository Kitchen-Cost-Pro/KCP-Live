// Single source of truth for "is this log entry wastage" across the dashboard tile,
// Adjustments log, and Analytics/Ops reports. Wastage is its own adjustment_type
// ('wastage') on the backend, or carries an explicit wasteReason/waste note. A plain
// 'remove' with no wasteReason is a manual stock correction, NOT wastage — treating it
// as wastage previously inflated the dashboard tile and emptied Manual Adjustments.
export function isWastageAdjustment(log = {}) {
  const mode = String(log.mode || '').toLowerCase();
  const note = String(log.note || log.reason || '').toLowerCase();
  return mode === 'wastage' || Boolean(log.wasteReason) || note.includes('waste') || note.includes('wastage');
}
