/**
 * Calculates the mean value for a modifier group using the catalogue option
 * count as the denominator. Missing/unresolved option values contribute zero,
 * which keeps the result aligned with the total number of selectable options.
 */
export function averageModifierOptionValue(values = [], totalOptions = 0) {
  const normalized = (values || [])
    .map(Number)
    .filter(Number.isFinite);
  const requestedCount = Math.max(0, Number(totalOptions) || 0);
  const denominator = requestedCount || normalized.length;
  if (!denominator) return 0;
  return normalized.reduce((sum, value) => sum + value, 0) / denominator;
}
