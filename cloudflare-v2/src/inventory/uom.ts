/**
 * One shared definition of how a recipe line's unit resolves against a stock item's base unit.
 *
 * This logic existed in four separate copies that disagreed with each other, which is what caused
 * the 2026-08-28 incident on WS-leo-s-demo-de3159: a "2 kg Beef Mince" recipe line costed
 * correctly in reporting, displayed correctly in the editor, and deducted nothing at all. The two
 * stock-mutating copies (effect-proposals.ts, recipe-expansion.ts) now both use this module.
 *
 * The reporting copies keep their own equivalent tables for now — `convertMenuRecipeQty` in
 * legacy/reporting-routes.ts and STANDARD_UOM_FACTORS in the frontend's
 * modules/reporting/engine/recipeExplosion.js. Keep all four in step when changing this.
 */

/**
 * The recipe editor writes this into `recipe_lines.unit` whenever no explicit UOM was chosen
 * (normalizeRecipeLines in services/recipeService.js). It does NOT mean "each" — it means
 * "unspecified", and the editor renders such a line using the stock item's own base unit. Treating
 * it as a real unit is what produced both the silent non-deduction and the misleading
 * "Missing UOM conversion from ea to kg." menu-health warning.
 */
export const UNSPECIFIED_LINE_UOM = 'ea';

/** Family + factor expressed in the family's canonical unit (kg for mass, l for volume). */
const STANDARD_UOM_FAMILIES: Record<string, readonly [string, number]> = {
  mg: ['mass', 0.000001],
  g: ['mass', 0.001],
  gram: ['mass', 0.001],
  grams: ['mass', 0.001],
  gramme: ['mass', 0.001],
  grammes: ['mass', 0.001],
  kg: ['mass', 1],
  kilo: ['mass', 1],
  kilos: ['mass', 1],
  kilogram: ['mass', 1],
  kilograms: ['mass', 1],
  ml: ['volume', 0.001],
  millilitre: ['volume', 0.001],
  milliliter: ['volume', 0.001],
  millilitres: ['volume', 0.001],
  milliliters: ['volume', 0.001],
  cl: ['volume', 0.01],
  l: ['volume', 1],
  lt: ['volume', 1],
  litre: ['volume', 1],
  liter: ['volume', 1],
  litres: ['volume', 1],
  liters: ['volume', 1],
  ea: ['count', 1],
  each: ['count', 1],
  unit: ['count', 1],
  units: ['count', 1],
  pc: ['count', 1],
  pcs: ['count', 1],
  piece: ['count', 1],
  pieces: ['count', 1]
};

/** Lowercase and strip separators/punctuation so "Kg", "kg." and "KG" all key the same entry. */
export function normalizeUomKey(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function isUnspecifiedUom(value: unknown): boolean {
  return normalizeUomKey(value) === UNSPECIFIED_LINE_UOM;
}

/**
 * Convert between two standard units of the SAME physical family (g -> kg, ml -> l).
 * Returns null when either unit is non-standard or they belong to different families — notably
 * `ea -> kg`, which is not a conversion at all but the unspecified-unit sentinel above.
 *
 * Restaurant recipes are written in grams and millilitres against items stocked in kg and litres;
 * before this, the stock path could only do that if someone had hand-configured a custom UOM per
 * item, while reporting converted it natively. That mismatch meant reporting and stock disagreed
 * about the very same recipe line.
 */
export function standardUomFactor(fromUom: unknown, toUom: unknown): number | null {
  const from = STANDARD_UOM_FAMILIES[normalizeUomKey(fromUom)];
  const to = STANDARD_UOM_FAMILIES[normalizeUomKey(toUom)];
  if (!from || !to || from[0] !== to[0]) return null;
  return from[1] / to[1];
}
