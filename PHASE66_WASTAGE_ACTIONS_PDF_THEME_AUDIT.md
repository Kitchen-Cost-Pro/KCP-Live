# Phase 66 Wastage Actions and PDF Theme Audit

## Scope

This phase fixes missing interaction feedback in wastage-related dropdowns and standardises every jsPDF export path on the Kitchen Cost Pro application theme.

## Wastage dropdown interaction fix

### Wastage adjustment selectors

The Location and Reason option lists in the wastage adjustment workflow now provide clear feedback for mouse and keyboard users:

- Strong blue hover background and border
- White option text on hover
- Inset accent indicator
- Small horizontal movement to make the state obvious
- Visible `:focus-visible` styling for keyboard navigation
- Consistent active-item styling
- Smooth transition without changing selection behaviour

Updated file:

- `src/styles/adjustments.css`

### Reporting Actions menu

The reporting Actions dropdown now applies the same visible interaction language to:

- PDF, XLSX, and CSV export actions
- Saved-view items
- Column visibility options
- Keyboard focus states
- Active saved views

Updated file:

- `src/styles/reporting.css`

## Shared PDF theme

A single reusable KCP PDF palette and table configuration was added in:

- `src/utils/pdfTheme.js`

The palette uses the main application colours:

- KCP accent blue: `#0099E0`
- Dark accent blue: `#0070A8`
- KCP navy: `#0F2D4C`
- Blue-grey body text and borders
- Light-blue surfaces and alternating rows
- White table header text
- Existing semantic green and amber states for reconciliation and warnings

## PDF paths updated

### Reporting PDFs

Updated `src/modules/reporting/exports/exportPdf.js`.

Coverage includes:

- Every manual report PDF
- Wastage reports
- Sales and stock movement reports
- Payment reports
- Modifier reports
- Inventory and purchasing reports
- Combined report packs
- Scheduled report PDF attachments, because scheduling reuses this export engine

### Transaction-detail PDFs

Updated `src/modules/reporting/transactions/transactionDetailExports.js`.

Coverage includes:

- GRV details
- Credit notes and refund details
- Manufacturing batches
- Transfers
- Stock takes
- Summary cards, facts, reconciliation blocks, line-item tables, and footers

### General and structured PDFs

Updated `src/services/dataService.js`.

Coverage includes:

- Generic object-table PDFs
- Array-of-arrays PDFs
- Structured documents
- Information cards
- Supplier purchase orders
- Shared document headers and rules

### Stock-count sheet PDFs

Updated the stock-count PDF override in:

- `src/main.js`

Stock-count sheets now use the same blue header, navy text, blue-grey grid, light-blue category rows, and alternating surfaces.

## Regression protection

Added:

- `src/phase66WastageDropdownPdfTheme.test.js`

The tests verify:

1. Wastage dropdown options have visible hover and keyboard-focus feedback.
2. Reporting Actions, saved views, and column controls provide visible feedback.
3. All central PDF generators use the shared KCP theme.
4. A real Wastage Report PDF is generated with blue table headers, white header text, blue-grey body text, and light-blue alternating rows.
5. Legacy black PDF header literals are absent from the PDF source paths.

## Validation results

- 450 tests passed
- 0 tests failed
- Vite production build passed
- Worker TypeScript check passed
- Wrangler deployment dry run passed
- ZIP integrity check passed
- Source audit found all jsPDF entry points in the centralised and updated files
- Source audit found no remaining hardcoded black table-header or black body-text PDF colours

## Visual PDF inspection

Representative PDFs were generated, rendered to PNG at 160 DPI, and visually inspected:

- Wastage report
- Credit note transaction detail
- Stock-count sheet
- Supplier purchase order

Results:

- No black table headers
- No clipping or overlapping content
- Consistent KCP blue and navy hierarchy
- Readable table contrast
- Light-blue alternating rows
- Existing logos and business branding remain supported

## Deployment note

The package is production-build validated but has not been deployed from this environment.
