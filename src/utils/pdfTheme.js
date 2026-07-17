/**
 * Shared Kitchen Cost Pro PDF palette.
 *
 * PDF exports are intentionally rendered on a light page for printing, while
 * retaining the application's navy surfaces and cyan-blue accent language.
 * Keeping these values in one module prevents reports, stock sheets,
 * transaction drawers, purchase orders, and scheduled PDFs from drifting.
 */
export const KCP_PDF_THEME = Object.freeze({
  accent: [0, 153, 224],
  accentDark: [0, 112, 168],
  navy: [15, 45, 76],
  navySoft: [30, 67, 101],
  ink: [32, 61, 89],
  text: [51, 75, 101],
  muted: [91, 111, 137],
  border: [183, 205, 226],
  borderStrong: [143, 179, 207],
  surface: [245, 249, 252],
  surfaceAlt: [233, 245, 252],
  surfaceStrong: [217, 239, 250],
  white: [255, 255, 255],
  successSurface: [236, 253, 245],
  successBorder: [167, 243, 208],
  successText: [6, 95, 70],
  warningSurface: [255, 247, 237],
  warningBorder: [253, 186, 116],
  warningText: [154, 52, 18]
});

export function kcpPdfTableTheme(overrides = {}) {
  return {
    styles: {
      textColor: KCP_PDF_THEME.text,
      lineColor: KCP_PDF_THEME.border,
      lineWidth: 0.35,
      ...(overrides.styles || {})
    },
    headStyles: {
      fillColor: KCP_PDF_THEME.accentDark,
      textColor: KCP_PDF_THEME.white,
      fontStyle: 'bold',
      lineColor: KCP_PDF_THEME.accentDark,
      ...(overrides.headStyles || {})
    },
    alternateRowStyles: {
      fillColor: KCP_PDF_THEME.surfaceAlt,
      ...(overrides.alternateRowStyles || {})
    },
    bodyStyles: {
      fillColor: KCP_PDF_THEME.white,
      ...(overrides.bodyStyles || {})
    }
  };
}

export function drawKcpPdfTopAccent(doc, height = 6) {
  if (!doc?.internal?.pageSize) return;
  doc.setFillColor(...KCP_PDF_THEME.accent);
  doc.rect(0, 0, doc.internal.pageSize.getWidth(), height, 'F');
}
