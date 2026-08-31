// Single source of truth for "is this log entry wastage" across the dashboard tile,
// Adjustments log, and dashboard summaries. Wastage is its own adjustment_type
// ('wastage') on the backend, or carries an explicit wasteReason/waste note. A plain
// 'remove' with no wasteReason is a manual stock correction, NOT wastage - treating it
// as wastage previously inflated the dashboard tile and emptied Manual Adjustments.
// Product Sales Adjustment ('sale') is its own distinct adjustment_type -- a manual correction for
// a sale the POS never captured, not stock loss. Checked first and excluded from isWastageAdjustment
// below so a sale-adjustment note that happens to mention a wastage-sounding word never gets swept
// into wastage totals.
export function isSalesAdjustment(log = {}) {
  const mode = String(log.mode || log.adjustmentType || log.adjustment_type || '').toLowerCase();
  return mode === 'sale' || mode === 'saleadjustment' || mode === 'sale_adjustment';
}

export function isWastageAdjustment(log = {}) {
  if (isSalesAdjustment(log)) return false;
  const mode = String(log.mode || log.adjustmentType || log.adjustment_type || '').toLowerCase();
  const note = String(log.note || log.notes || log.reason || '').toLowerCase();

  if (mode === 'add' || mode === 'override') {
    return false;
  }

  return mode === 'wastage' || Boolean(log.wasteReason || log.waste_reason) || note.includes('waste') || note.includes('wastage');
}
