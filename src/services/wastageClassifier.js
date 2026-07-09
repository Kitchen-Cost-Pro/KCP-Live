// Single source of truth for "is this log entry wastage" across the dashboard tile,
// Adjustments log, and Analytics/Ops reports. Wastage is its own adjustment_type
// ('wastage') on the backend, or carries an explicit wasteReason/waste note. A plain
// 'remove' with no wasteReason is a manual stock correction, NOT wastage — treating it
// as wastage previously inflated the dashboard tile and emptied Manual Adjustments.
export function isWastageAdjustment(log = {}) {
  const mode = String(log.mode || log.adjustmentType || log.adjustment_type || '').toLowerCase();
  const note = String(log.note || log.notes || log.reason || '').toLowerCase();
  
  if (mode === 'add' || mode === 'override') {
    return false;
  }
  
  return mode === 'wastage' || mode === 'remove' || Boolean(log.wasteReason || log.waste_reason) || note.includes('waste') || note.includes('wastage');
}
