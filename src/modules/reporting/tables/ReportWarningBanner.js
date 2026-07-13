// Customer-facing reports keep row-level, actionable issue indicators but do
// not render a global data-quality banner. The report result still retains its
// warnings for diagnostics, validation, exports, and automated checks.
export function renderReportWarningBanner() {
  return document.createDocumentFragment();
}

export default renderReportWarningBanner;
