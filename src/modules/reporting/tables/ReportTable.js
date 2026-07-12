import { escapeHtml, formatCell } from "../engine/formatters.js";
import { text, toArray } from "../engine/grouping.js";
import { flattenWarnings } from "../validators/rowWarningUtils.js";
import {
  isUserFixableWarning,
  isSystemOwnedReportingWarning,
} from "../validators/warningCategories.js";
import { renderTooltipIcon } from "../tooltips/tooltipBuilder.js";
import { renderReportTotalsRow } from "./ReportTotalsRow.js";
import { renderSparklineSvg } from "../visuals/ReportSparkline.js";
import {
  isTransactionIdColumn,
  prioritizeTransactionColumns,
} from "../transactions/transactionColumnVisibility.js";

export function renderReportTable(result = {}, options = {}) {
  const columns = prioritizeTransactionColumns(result.columns).filter(
    (column) => !shouldHideColumnInDashboard(column),
  );
  const rows = toArray(result.rows);
  const selectableRows = options.selectableRows === true;
  const selectedRowKeys = new Set(
    toArray(options.selectedRowKeys).map((value) => text(value)),
  );
  const wrapper = document.createElement("div");
  const hasStickyTransactionColumn = columns.some((column) => isTransactionIdColumn(column));
  wrapper.className = `reportTableWrap${hasStickyTransactionColumn ? " reportTableWrap--stickyTransaction" : ""}`;
  const empty =
    options.emptyState || result.emptyState || result.report?.emptyState || {};
  const noDataTitle = escapeHtml(
    empty.title || "No report rows for the selected filters",
  );
  const noDataMessage = escapeHtml(
    empty.message ||
      "Values remain visible so the report is transparent even when no source rows exist.",
  );
  const visibleRowKeys = rows
    .map((row, index) => getReportRowSelectionKey(row, index))
    .filter(Boolean);
  const allVisibleSelected =
    selectableRows &&
    visibleRowKeys.length > 0 &&
    visibleRowKeys.every((key) => selectedRowKeys.has(key));
  wrapper.innerHTML = `
    <table class="reportTable${selectableRows ? " reportTable--selectable" : ""}">
      <thead>
        <tr>
          ${selectableRows ? renderSelectionHeaderCell(allVisibleSelected, visibleRowKeys.length) : ""}
          ${columns.map((column) => renderHeaderCell(column, result.sort)).join("")}
        </tr>
      </thead>
      <tbody>
        ${
          rows.length
            ? rows
                .map((row, index) => {
                  const rowKey = getReportRowSelectionKey(row, index);
                  return `
          <tr data-report-row="${escapeHtml(row.id || rowKey || index)}">
            ${selectableRows ? renderSelectionBodyCell(rowKey, selectedRowKeys.has(rowKey), row, index) : ""}
            ${columns.map((column, columnIndex) => renderBodyCell(row, column, columnIndex, result.warnings, result)).join("")}
          </tr>`;
                })
                .join("")
            : `
          <tr class="reportTable__noDataRow">
            <td colspan="${Math.max(1, columns.length + (selectableRows ? 1 : 0))}">
              <strong>${noDataTitle}</strong>
              <span>${noDataMessage}</span>
            </td>
          </tr>
        `
        }
      </tbody>
      ${renderReportTotalsRow(selectableRows ? [{ key: "__select", label: "", sortable: false }, ...columns] : columns, result.totals)}
    </table>
  `;
  return wrapper;
}

function renderSelectionHeaderCell(
  allVisibleSelected = false,
  visibleCount = 0,
) {
  return `
    <th class="reportTable__selectCell reportTable__selectCell--head">
      <label class="reportSelectionCheckbox" title="Select all visible low-stock items">
        <input type="checkbox" data-report-select-all ${allVisibleSelected ? "checked" : ""} ${visibleCount ? "" : "disabled"} />
        <span>Select</span>
      </label>
    </th>
  `;
}

function renderSelectionBodyCell(
  rowKey = "",
  selected = false,
  row = {},
  index = 0,
) {
  const label = text(
    row.itemName ||
      row.stockItemName ||
      row.inventoryItemName ||
      row.name ||
      `row ${index + 1}`,
  );
  return `
    <td class="reportTable__selectCell">
      <label class="reportSelectionCheckbox reportSelectionCheckbox--row" title="Select ${escapeHtml(label)}">
        <input type="checkbox" data-report-select-row="${escapeHtml(rowKey)}" ${selected ? "checked" : ""} />
        <span class="srOnly">Select ${escapeHtml(label)}</span>
      </label>
    </td>
  `;
}

export function getReportRowSelectionKey(row = {}, index = 0) {
  const explicit = text(
    row.id ||
      row.rowId ||
      row.lineId ||
      row.stockItemId ||
      row.itemId ||
      row.inventoryItemId ||
      row.productId ||
      row.menuItemId,
  );
  const location = text(row.locationId || row.locationName);
  if (explicit || location)
    return [explicit || `row-${index}`, location].filter(Boolean).join("::");
  return `row-${index}`;
}

function renderHeaderCell(column = {}, sort = {}) {
  const width = column.width
    ? ` style="width:${escapeHtml(column.width)}"`
    : "";
  const className = isTransactionIdColumn(column)
    ? ' class="reportTable__transactionColumn"'
    : "";
  const columnKey = ` data-column-key="${escapeHtml(column.key || "")}"`;
  const label = `${escapeHtml(column.label || column.key)} ${column.tooltipKey ? renderTooltipIcon(column.tooltipKey) : ""}`;
  if (column.sortable === false) return `<th${className}${columnKey}${width}>${label}</th>`;
  const active = text(sort?.key) === text(column.key);
  const direction = active && sort?.direction === "desc" ? "desc" : "asc";
  const nextDirection = active && direction === "asc" ? "desc" : "asc";
  const indicator = active ? (direction === "desc" ? " ↓" : " ↑") : "";
  return `<th${className}${columnKey}${width}><button type="button" class="reportTable__sort" data-sort-key="${escapeHtml(column.key)}" data-sort-direction="${escapeHtml(nextDirection)}">${label}${indicator}</button></th>`;
}

function renderBodyCell(
  row = {},
  column = {},
  columnIndex = 0,
  warnings = [],
  result = {},
) {
  const alignValue = resolveColumnAlign(column);
  const align = alignValue
    ? ` style="text-align:${escapeHtml(alignValue)}"`
    : "";
  const tooltip =
    typeof column.cellTooltip === "function" ? column.cellTooltip(row) : "";
  const safeTooltip = tooltip ? escapeHtml(tooltip) : "";
  const title = tooltip ? ` data-report-tooltip="${safeTooltip}"` : "";
  const classes = [
    "reportTable__cell",
    isNumericColumn(column) ? "is-numeric" : "",
    column.key === "sourceId" ? "is-source-id" : "",
    isTransactionIdColumn(column) ? "reportTable__transactionColumn" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const issue = columnIndex === 0 ? findRowIssue(row, warnings) : null;
  const issueHint = issue
    ? `<span class="reportTable__itemIssue" data-report-tooltip="${escapeHtml(issue)}" aria-label="Data quality issue">!</span>`
    : "";
  const shortcuts =
    columnIndex === 0 ? renderRowShortcuts(row, result, issue) : "";
  return `<td class="${escapeHtml(classes)}" data-column-key="${escapeHtml(column.key || "")}"${align}${title}>${renderCellContent(row[column.key], column, row, result)}${issueHint}${shortcuts}</td>`;
}

function renderCellContent(value, column = {}, row = {}, result = {}) {
  const type = String(column.type || "").toLowerCase();
  if (type === "badge") {
    const label = formatCell(value, column);
    const tone =
      String(value || "neutral")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "") || "neutral";
    return `<span class="reportRiskBadge reportRiskBadge--${escapeHtml(tone)}">${escapeHtml(label)}</span>`;
  }
  if (type === "sparkline") {
    return renderSparklineSvg(Array.isArray(value) ? value : [], {
      width: 120,
      height: 32,
      label: column.label || "Trend",
    });
  }
  if (type === "transaction_id") {
    const reference = formatCell(value, column);
    if (!reference) return "";
    const identity = resolveTransactionIdentity(row, result, reference);
    return `<button type="button" class="reportTable__transactionLink" data-report-transaction-id="${escapeHtml(reference)}" data-report-transaction-type="${escapeHtml(identity.entityType)}" data-report-transaction-entity-id="${escapeHtml(identity.entityId)}" aria-label="Open transaction ${escapeHtml(reference)}">${escapeHtml(reference)}</button>`;
  }
  return escapeHtml(formatCell(value, column));
}

function resolveTransactionIdentity(row = {}, result = {}, reference = "") {
  const reportId = text(result.report?.id || result.reportId || result.id).toLowerCase();
  const prefix = text(reference).toUpperCase().split("-")[0];
  const entityType =
    reportId === "grv_log" || prefix === "GRV"
      ? "grv"
      : reportId === "credit_notes" || prefix === "CN"
        ? "credit_note"
        : reportId === "manufacturing_transactions" || prefix === "MFG"
          ? "manufacturing_batch"
          : reportId === "stock_transfers" || prefix === "TRF"
            ? "transfer"
            : reportId === "stock_take_audit" || prefix === "STK"
              ? "stock_take"
              : "";
  const entityId = text(
    row.grvId ||
      row.creditNoteId ||
      row.manufacturingBatchId ||
      row.transferId ||
      row.stockTakeSessionId ||
      row.sessionId ||
      row.sourceId ||
      row.documentId,
  );
  return { entityType, entityId };
}

function shouldHideColumnInDashboard(column = {}) {
  // Customer-facing transaction references are deliberately typed as
  // `transaction_id`. They are the entry point to the shared transaction
  // drawer and must never be treated like hidden internal database IDs.
  if (isTransactionIdColumn(column)) return false;
  if (column.showInDashboard === false || column.hideInDashboard === true)
    return true;
  const key = text(column.key).trim();
  const label = text(column.label).trim().toLowerCase();
  const hiddenKeys = new Set([
    "id",
    "rowId",
    "lineId",
    "auditId",
    "sourceRowId",
    "sourceId",
    "source_id",
    "itemId",
    "item_id",
    "stockItemId",
    "stock_item_id",
    "inventoryItemId",
    "inventory_item_id",
    "menuItemId",
    "menu_item_id",
    "productId",
    "product_id",
    "recipeId",
    "recipe_id",
    "modifierId",
    "modifier_id",
    "modifierGroupId",
    "modifier_group_id",
    "saleId",
    "sale_id",
    "transferId",
    "transfer_id",
    "stockTakeId",
    "stock_take_id",
    "stockTakeSessionId",
    "sessionId",
    "entityId",
    "locationId",
    "fromLocationId",
    "toLocationId",
    "userId",
    "workspaceId",
    "sourceDocumentId",
    "source_document_id",
  ]);
  if (hiddenKeys.has(key)) return true;
  if (/^[a-z]+Id$/.test(key) && !["receiptId"].includes(key)) return true;
  return (
    /\b(id|source id|item id|product id|menu item id|stock item id|location id)\b/.test(
      label,
    ) && !/receipt|invoice|order number|po number/.test(label)
  );
}

function renderRowShortcuts(row = {}, result = {}, issueText = "") {
  const shortcuts = resolveRowShortcuts(row, result, issueText);
  if (!shortcuts.length) return "";
  return `<span class="reportTable__shortcuts" aria-label="Quick actions">${shortcuts.map((shortcut) => renderShortcutPill(shortcut)).join("")}</span>`;
}

function renderShortcutPill(shortcut = {}) {
  const payload = encodeURIComponent(JSON.stringify(shortcut.payload || {}));
  const label = escapeHtml(shortcut.label || "Open");
  const tone = escapeHtml(shortcut.tone || "neutral");
  return `<button type="button" class="reportTable__shortcutPill reportTable__shortcutPill--${tone}" data-report-shortcut="${payload}">${label}</button>`;
}

function resolveRowShortcuts(row = {}, result = {}, issueText = "") {
  const reportId = text(
    result.report?.id || result.reportId || result.id,
  ).toLowerCase();
  const view = text(result.view).toLowerCase();
  const haystack = [
    issueText,
    row.issue,
    row.suggestedFix,
    row.status,
    row.recipeStatus,
    row.stockDeductionStatus,
    row.riskStatus,
    row.issueType,
    row.actionRequired,
  ]
    .map((value) => text(value).toLowerCase())
    .join(" ");
  const itemId = text(
    row.menuItemId ||
      row.itemId ||
      row.productId ||
      row.sourceId ||
      row.stockItemId ||
      row.inventoryItemId,
  );
  const itemName = text(
    row.menuItemName ||
      row.itemName ||
      row.productName ||
      row.inventoryItemName ||
      row.inventoryIngredient ||
      row.entityName ||
      row.name,
  );
  const shortcuts = [];

  const missingRecipe =
    /missing recipe|recipe missing|no recipe|add recipe|recipe setup|not recipe-ready|recipe incomplete|missing menu recipe|recipe or modifier setup/.test(
      haystack,
    ) ||
    row.missingRecipe === true ||
    row.hasRecipe === false ||
    String(row.recipeStatus || "")
      .toLowerCase()
      .includes("missing");
  if (missingRecipe && (itemId || itemName)) {
    shortcuts.push({
      label: "Create Recipe",
      tone: "recipe",
      payload: {
        action: "openRecipe",
        menuItemId: text(
          row.menuItemId || row.productId || row.itemId || row.sourceId,
        ),
        itemId,
        itemName,
        menuItemName: text(
          row.menuItemName || row.itemName || row.productName || itemName,
        ),
      },
    });
  }

  const lowStockView =
    reportId === "stock_control" &&
    ["item_detail", "reorder_detail", "warnings"].includes(view);
  const needsReorder =
    lowStockView &&
    (safeNumber(row.requiredQty) > 0 ||
      /low|critical|below par|reorder/.test(haystack));
  if (needsReorder && (text(row.itemId || row.stockItemId) || itemName)) {
    shortcuts.push({
      label: "Create PO",
      tone: "po",
      payload: {
        action: "createPurchaseOrder",
        itemId: text(row.itemId || row.stockItemId || row.sourceId),
        itemName,
        locationId: text(row.locationId),
        locationName: text(row.locationName),
        supplierId: text(row.supplierId),
        supplierName: text(row.supplierName),
        requiredQty: safeNumber(row.requiredQty),
        purchaseUom: text(row.purchaseUom || row.baseUom),
        purchaseUomQty: safeNumber(row.purchaseUomQty || row.requiredQty),
        unitCostExVat: safeNumber(row.unitCostExVat || row.lastPurchaseCost),
      },
    });
  }

  if (
    /missing cost|unit cost|no cost|cost missing/.test(haystack) &&
    (text(row.stockItemId || row.inventoryItemId || row.itemId) || itemName)
  ) {
    shortcuts.push({
      label: "Fix Stock Item",
      tone: "stock",
      payload: {
        action: "openStockItem",
        itemId: text(
          row.stockItemId || row.inventoryItemId || row.itemId || row.sourceId,
        ),
        itemName,
      },
    });
  }

  if (
    /unmapped menu|menu mapping|missing menu item|yoco sale line/.test(
      haystack,
    ) &&
    (itemId || itemName)
  ) {
    shortcuts.push({
      label: "Open Menu",
      tone: "menu",
      payload: {
        action: "openMenuItem",
        itemId,
        itemName,
      },
    });
  }

  if (/missing supplier|supplier missing|no supplier/.test(haystack)) {
    shortcuts.push({
      label: "Suppliers",
      tone: "supplier",
      payload: {
        action: "openSuppliers",
        supplierName: text(row.supplierName),
        itemName,
      },
    });
  }

  const seen = new Set();
  return shortcuts
    .filter((shortcut) => {
      const key = `${shortcut.label}:${shortcut.payload?.action}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 2);
}

function safeNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function resolveColumnAlign(column = {}) {
  if (column.align) return column.align;
  if (isNumericColumn(column)) return "right";
  return "left";
}

function isNumericColumn(column = {}) {
  return ["money", "number", "percent", "qty", "quantity"].includes(
    String(column.type || "").toLowerCase(),
  );
}

function findRowIssue(row = {}, warnings = []) {
  const rowIds = [
    row.id,
    row.rowId,
    row.lineId,
    row.auditId,
    row.sourceRowId,
    row.itemId,
    row.menuItemId,
    row.productId,
    row.inventoryItemId,
    row.stockItemId,
    row.entityId,
    row.sourceId,
    row.saleId,
    row.transferId,
    row.stockTakeId,
    row.sessionId,
    row.locationId,
    row.fromLocationId,
    row.toLocationId,
  ]
    .map((value) => text(value).toLowerCase())
    .filter(Boolean);
  const rowNames = [
    row.itemName,
    row.menuItemName,
    row.productName,
    row.inventoryItemName,
    row.inventoryIngredient,
    row.stockItemName,
    row.entityName,
    row.name,
    row.transferNumber,
    row.receiptNumber,
    row.locationName,
    row.fromLocationName,
    row.toLocationName,
  ]
    .map((value) => text(value).toLowerCase())
    .filter(Boolean);
  const matches = flattenWarnings(warnings).filter((warning) => {
    const candidate =
      typeof warning === "string" ? { message: warning } : warning || {};
    const warningIds = [
      candidate.rowId,
      candidate.id,
      candidate.itemId,
      candidate.menuItemId,
      candidate.productId,
      candidate.inventoryItemId,
      candidate.stockItemId,
      candidate.entityId,
      candidate.sourceId,
      candidate.saleId,
      candidate.transferId,
      candidate.stockTakeId,
      candidate.sessionId,
      candidate.locationId,
      candidate.fromLocationId,
      candidate.toLocationId,
    ]
      .map((value) => text(value).toLowerCase())
      .filter(Boolean);
    const warningNames = [
      candidate.itemName,
      candidate.menuItemName,
      candidate.productName,
      candidate.entityName,
      candidate.inventoryItemName,
      candidate.stockItemName,
      candidate.locationName,
      candidate.fromLocationName,
      candidate.toLocationName,
    ]
      .map((value) => text(value).toLowerCase())
      .filter(Boolean);
    const message = text(candidate.message || warning).toLowerCase();
    const explicitMatch =
      warningIds.some((value) => rowIds.includes(value)) ||
      warningNames.some((value) => rowNames.includes(value)) ||
      rowNames.some((value) => value.length > 2 && message.includes(value));
    if (
      !isUserFixableWarning(candidate) ||
      isSystemOwnedReportingWarning(candidate)
    )
      return false;
    if (explicitMatch) return true;
    return aggregateWarningAppliesToRow(candidate, row);
  });
  if (!matches.length) return "";
  return Array.from(
    new Set(
      matches.map((warning) => cleanRowIssueText(warning, row)).filter(Boolean),
    ),
  ).join("\n");
}

function isSystemOwnedWarning(warning = {}) {
  return isSystemOwnedReportingWarning(warning);
}

function aggregateWarningAppliesToRow(warning = {}, row = {}) {
  if (!isUserFixableWarning(warning) || isSystemOwnedReportingWarning(warning))
    return false;
  const combined =
    `${text(warning.code)} ${text(warning.message || warning)}`.toLowerCase();
  if (!combined) return false;

  if (
    /missing.*(item name)|item names.*missing|missing-item-name/.test(combined)
  ) {
    return (
      !text(
        row.itemName ||
          row.stockItemName ||
          row.productName ||
          row.menuItemName ||
          row.inventoryItemName ||
          row.inventoryIngredient ||
          row.name,
      ) &&
      hasAny(row, [
        "itemId",
        "stockItemId",
        "productId",
        "menuItemId",
        "inventoryItemId",
      ])
    );
  }
  if (
    /missing.*(location name)|location names.*missing|missing-location-name|unmapped location|not mapped to local locations/.test(
      combined,
    )
  ) {
    return (
      hasAny(row, ["locationId", "fromLocationId", "toLocationId"]) &&
      !text(row.locationName || row.fromLocationName || row.toLocationName)
    );
  }
  if (
    /missing.*(unit cost)|unit costs.*missing|zero unit cost|missing-unit-cost|unit cost/.test(
      combined,
    )
  ) {
    return (
      rowHasMovementOrValue(row) &&
      safeNumber(row.unitCostExVat ?? row.unitCost) === 0
    );
  }
  if (
    /missing.*(source id)|source ids.*missing|source-id-missing/.test(combined)
  ) {
    return (
      !text(row.sourceId || row.documentId || row.sourceDocumentId) &&
      rowHasMovementOrValue(row)
    );
  }
  if (/missing.*(sale id)|sale ids.*missing|missing-sale-id/.test(combined)) {
    return (
      !text(row.saleId || row.sourceId || row.id) &&
      hasAny(row, [
        "receiptNumber",
        "grossAmount",
        "netAmount",
        "qtySold",
        "qtyUsed",
      ])
    );
  }
  if (
    /missing.*receipt|receipt.*missing|receipt-number-missing/.test(combined)
  ) {
    return (
      !text(row.receiptNumber) &&
      hasAny(row, ["saleId", "grossAmount", "netAmount", "qtySold", "qtyUsed"])
    );
  }
  if (/missing.*payment method|payment-method/.test(combined)) {
    return (
      !text(row.paymentMethod) &&
      hasAny(row, ["grossAmount", "netAmount", "receiptNumber"])
    );
  }
  if (
    /missing.*ingredient|ingredient stock item|recipe.*stock item|unmapped ingredient/.test(
      combined,
    )
  ) {
    return (
      !text(row.inventoryItemId || row.stockItemId) ||
      /unmapped ingredient/i.test(
        text(row.inventoryItemName || row.inventoryIngredient),
      )
    );
  }
  if (/missing.*uom|base uom|uom conversion/.test(combined)) {
    return (
      !text(row.baseUom || row.unit || row.uom) && rowHasMovementOrValue(row)
    );
  }
  if (
    /missing recipe|recipe.*missing|no recipe|sold recipe items are missing recipes/.test(
      combined,
    )
  ) {
    return (
      row.missingRecipe === true ||
      row.hasRecipe === false ||
      text(row.recipeWarningCode).toLowerCase() === "missing-recipe" ||
      /missing recipe/i.test(
        text(row.warningsText || row.issue || row.status || row.recipeStatus),
      )
    );
  }
  if (/circular recipe/.test(combined)) {
    return (
      text(row.recipeWarningCode).toLowerCase() === "circular-recipe" ||
      /circular/i.test(text(row.warningsText || row.issue))
    );
  }
  if (
    /sale usage movement is missing|usage movement.*missing|no movement row/.test(
      combined,
    )
  ) {
    return row.expectedUsageMovement === true && row.hasUsageMovement === false;
  }
  if (
    /modifier.*stock.*mapping|stock-deducting modifiers|modifier.*mapping/.test(
      combined,
    )
  ) {
    return (
      text(row.sourceType) === "Modifier Usage" &&
      (!text(row.inventoryItemId || row.stockItemId) ||
        row.hasUsageMovement === false ||
        row.stockDeductingModifier === true)
    );
  }
  if (/qty in.*qty out|both qty in and qty out/.test(combined)) {
    return safeNumber(row.qtyIn) > 0 && safeNumber(row.qtyOut) > 0;
  }
  if (/zero movement|both qty in and qty out as zero/.test(combined)) {
    return (
      safeNumber(row.qtyIn) === 0 &&
      safeNumber(row.qtyOut) === 0 &&
      safeNumber(row.netQty) === 0 &&
      rowHasMovementOrValue(row)
    );
  }
  if (
    /movement value.*mismatch|net qty x unit cost|does not match/.test(combined)
  ) {
    const unitCost = safeNumber(row.unitCostExVat ?? row.unitCost);
    const actual = safeNumber(
      row.movementValue ?? row.stockValueUsed ?? row.valueImpact,
    );
    const expected =
      safeNumber(row.netQty ?? row.qtyUsed ?? row.totalQtyUsed) * unitCost;
    return Math.abs(actual - expected) > 0.01 && (actual || expected);
  }
  if (
    /opening stock snapshots|actual closing stock snapshots|variance.*cannot/.test(
      combined,
    )
  ) {
    return (
      safeNumber(row.missingOpeningCount) > 0 ||
      safeNumber(row.missingActualCount) > 0
    );
  }
  return false;
}

function cleanRowIssueText(warning = {}, row = {}) {
  const raw = text(warning?.message || warning);
  if (!raw) return "";
  const rowLabels = [
    row.itemName,
    row.menuItemName,
    row.productName,
    row.inventoryItemName,
    row.inventoryIngredient,
    row.stockItemName,
    row.entityName,
    row.name,
    row.locationName,
    row.receiptNumber,
    row.documentNumber,
  ]
    .map(text)
    .filter(Boolean);
  let clean = raw.replace(/^\d+\s+/, "").trim();
  for (const label of rowLabels) {
    const pattern = new RegExp(`^${escapeRegExp(label)}\\s*[-–—:]\\s*`, "i");
    clean = clean.replace(pattern, "");
  }
  clean = clean
    .replace(
      /^(?:report|ledger|usage|stock usage|sale|sales|committed|real|line detail|stock take|transfer|wastage|adjustment)\s+row\(s\)\s+/i,
      "",
    )
    .replace(
      /^(?:report|ledger|usage|stock usage|sale|sales|committed|real|line detail|stock take|transfer|wastage|adjustment)\s+rows?\s+/i,
      "",
    )
    .replace(/^rows?\s+/i, "")
    .replace(/^lines?\s+/i, "")
    .replace(/\brows?\b/gi, "line")
    .replace(/\brow\(s\)\b/gi, "line")
    .replace(/\bline\(s\)\b/gi, "line")
    .trim();
  clean = clean || "Review this line.";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function hasAny(row = {}, keys = []) {
  return keys.some((key) => text(row[key] ?? "").trim());
}

function rowHasMovementOrValue(row = {}) {
  return (
    [
      "qtyIn",
      "qtyOut",
      "netQty",
      "qtyUsed",
      "totalQtyUsed",
      "quantity",
      "movementValue",
      "stockValueUsed",
      "valueImpact",
      "grossAmount",
      "netAmount",
    ].some(
      (key) => Number.isFinite(Number(row[key])) && Number(row[key]) !== 0,
    ) ||
    hasAny(row, [
      "movementType",
      "sourceType",
      "source",
      "receiptNumber",
      "documentNumber",
    ])
  );
}

function escapeRegExp(value = "") {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
