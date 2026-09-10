import { escapeHtml } from "../engine/formatters.js";
import { fetchTransactionDetail, fetchEntityInvoiceFile } from "./transactionDetailService.js";
import { getTransactionDetailDefinition } from "./transactionDetailRegistry.js";
import {
  downloadTransactionDetailCsv,
  downloadTransactionDetailExcel,
  downloadTransactionDetailPdf,
} from "./transactionDetailExports.js";
import { formatTransactionDetailValue } from "./transactionDetailUtils.js";

let activeDrawer = null;

export function closeTransactionDetailDrawer({ restoreFocus = true } = {}) {
  activeDrawer?.close?.({ restoreFocus });
}

export function openTransactionDetailDrawer({
  workspaceId,
  transactionReference,
  entityType = "",
  entityId = "",
  trigger = null,
  services = {},
  branding = {},
  canExport = true,
} = {}) {
  const restoreTarget = activeDrawer?.restoreTarget || trigger;
  closeTransactionDetailDrawer({ restoreFocus: false });
  const overlay = document.createElement("div");
  overlay.className = "transactionDetailOverlay";
  overlay.innerHTML = `
    <section class="transactionDetailDrawer" role="dialog" aria-modal="true" aria-labelledby="transactionDetailTitle">
      <header class="transactionDetailDrawer__header">
        <div>
          <span class="transactionDetailDrawer__eyebrow">Transaction detail</span>
          <h2 id="transactionDetailTitle">${escapeHtml(transactionReference || "Transaction")}</h2>
          <p data-transaction-detail-subtitle>Loading transaction data…</p>
        </div>
        <button type="button" class="transactionDetailDrawer__close" data-transaction-detail-close aria-label="Close transaction detail">×</button>
      </header>
      <div class="transactionDetailDrawer__body" data-transaction-detail-body>
        <div class="transactionDetailDrawer__loading" role="status">Loading transaction details…</div>
      </div>
    </section>`;
  document.body.append(overlay);
  const drawer = overlay.querySelector(".transactionDetailDrawer");
  const closeButton = overlay.querySelector("[data-transaction-detail-close]");
  const previousOverflow = document.body.style.overflow;
  document.body.style.overflow = "hidden";

  const close = ({ restoreFocus = true } = {}) => {
    document.removeEventListener("keydown", onKeyDown);
    document.body.style.overflow = previousOverflow;
    overlay.remove();
    if (activeDrawer?.overlay === overlay) activeDrawer = null;
    if (restoreFocus) restoreTarget?.focus?.();
  };
  const onKeyDown = (event) => {
    if (event.key === "Escape") close();
    if (event.key === "Tab") trapFocus(event, drawer);
  };
  activeDrawer = { overlay, close, restoreTarget };
  closeButton?.addEventListener("click", close);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) close();
  });
  document.addEventListener("keydown", onKeyDown);
  closeButton?.focus();

  const loader = services?.reporting?.getTransactionDetail || fetchTransactionDetail;
  Promise.resolve(loader({ workspaceId, transactionReference, entityType, entityId }))
    .then((detail) => renderLoadedDetail(overlay, detail, { branding, canExport, workspaceId, services, entityType, entityId, close }))
    .catch((error) => renderDetailError(overlay, error));
  return overlay;
}

function renderLoadedDetail(overlay, detail = {}, { branding = {}, canExport = true, workspaceId = "", services = {}, entityType = "", entityId = "", close = () => {} } = {}) {
  const definition = getTransactionDetailDefinition(detail.entityType);
  const title = overlay.querySelector("#transactionDetailTitle");
  const subtitle = overlay.querySelector("[data-transaction-detail-subtitle]");
  const body = overlay.querySelector("[data-transaction-detail-body]");
  if (title) title.textContent = detail.transactionReference || "Transaction";
  if (subtitle) subtitle.textContent = [definition.label, detail.status, detail.occurredAt || detail.createdAt].filter(Boolean).join(" · ");
  if (!body) return;
  // Editing (Phase 1's patchGoodsReceipt/patchCreditNote) only exists for these two entity types
  // so far — the edit action is only offered when both the detail actually resolved to one of
  // them AND the host app wired up a handler for it (services.reportingActions.editGrv/
  // editCreditNote, from appShell.js — absent in contexts that don't support navigating there).
  const effectiveEntityType = detail.entityType || entityType;
  const editAction =
    effectiveEntityType === "grv" && typeof services?.reportingActions?.editGrv === "function"
      ? () => services.reportingActions.editGrv(entityId)
      : effectiveEntityType === "credit_note" && typeof services?.reportingActions?.editCreditNote === "function"
        ? () => services.reportingActions.editCreditNote(entityId)
        : null;
  body.innerHTML = `
    <div class="transactionDetailDrawer__toolbar">
      <div class="transactionDetailDrawer__identity">
        <span class="transactionDetailDrawer__type">${escapeHtml(definition.icon)}</span>
        <div><strong>${escapeHtml(detail.title || definition.label)}</strong><span>${escapeHtml((detail.locationNames || []).join(" · ") || "No location label")}</span></div>
      </div>
      <div class="transactionDetailDrawer__toolbarActions">
        ${editAction ? `<button type="button" class="transactionDetailDrawer__editButton" data-transaction-edit>Edit</button>` : ""}
        ${canExport ? `<div class="transactionDetailDrawer__exports" aria-label="Transaction exports">
          <button type="button" data-transaction-export="csv">CSV</button>
          <button type="button" data-transaction-export="xlsx">XLSX</button>
          <button type="button" data-transaction-export="pdf">PDF</button>
        </div>` : ""}
      </div>
    </div>
    ${renderSummaryCards(detail.summaryCards)}
    <nav class="transactionDetailTabs" aria-label="Transaction detail sections">
      <button type="button" class="is-active" data-transaction-tab="lineItems">Line Items <span>${(detail.lineItems || []).length}</span></button>
      <button type="button" data-transaction-tab="stockMovements">Stock Movements <span>${(detail.stockMovements || []).length}</span></button>
      <button type="button" data-transaction-tab="auditTrail">Audit Trail <span>${(detail.auditTrail || []).length}</span></button>
    </nav>
    <div class="transactionDetailPanel" data-transaction-panel></div>
    ${["grv", "stock_take"].includes(effectiveEntityType) && detail.metadata?.invoiceFileAvailable ? `
      <section class="transactionDetailInvoice" data-transaction-invoice>
        <button type="button" class="transactionDetailInvoice__toggle" data-transaction-invoice-toggle>Preview Invoice</button>
        <div class="transactionDetailInvoice__frame" data-transaction-invoice-frame hidden></div>
      </section>
    ` : ""}`;

  const panel = body.querySelector("[data-transaction-panel]");
  const renderTab = (tab) => {
    body.querySelectorAll("[data-transaction-tab]").forEach((button) => button.classList.toggle("is-active", button.dataset.transactionTab === tab));
    if (tab === "stockMovements") panel.innerHTML = renderStockMovements(detail.stockMovements || []);
    else if (tab === "auditTrail") panel.innerHTML = renderAuditTrail(detail.auditTrail || []);
    else panel.innerHTML = renderLineItems(detail.lineItems || [], detail.lineItemColumns || []);
  };
  body.querySelector(".transactionDetailTabs")?.addEventListener("click", (event) => {
    const button = event.target.closest("[data-transaction-tab]");
    if (button) renderTab(button.dataset.transactionTab);
  });
  body.querySelector("[data-transaction-edit]")?.addEventListener("click", () => {
    close({ restoreFocus: false });
    editAction?.();
  });
  body.querySelector('[data-transaction-export="csv"]')?.addEventListener("click", () => downloadTransactionDetailCsv(detail, { workspaceName: branding?.companyName }));
  body.querySelector('[data-transaction-export="xlsx"]')?.addEventListener("click", () => downloadTransactionDetailExcel(detail, { workspaceName: branding?.companyName }));
  body.querySelector('[data-transaction-export="pdf"]')?.addEventListener("click", () => downloadTransactionDetailPdf(detail, { branding, workspaceName: branding?.companyName }));
  // The invoice file itself is never fetched eagerly — a photo can run close to the 2MB upload
  // cap, and most visits to this drawer never open it — only loaded, as base64 JSON, the first
  // time the user clicks "Preview Invoice"; a second click just hides/shows the already-built
  // iframe again with no re-fetch.
  let invoiceObjectUrl = "";
  const revokeInvoiceObjectUrl = () => {
    if (!invoiceObjectUrl) return;
    URL.revokeObjectURL(invoiceObjectUrl);
    invoiceObjectUrl = "";
  };
  body.querySelector("[data-transaction-invoice-toggle]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const frame = body.querySelector("[data-transaction-invoice-frame]");
    if (!frame) return;
    if (frame.dataset.loaded === "true") {
      const nowHidden = !frame.hidden;
      frame.hidden = nowHidden;
      button.textContent = nowHidden ? "Preview Invoice" : "Hide Invoice";
      return;
    }
    button.disabled = true;
    button.textContent = "Loading…";
    try {
      const { mimeType, dataBase64 } = await fetchEntityInvoiceFile(workspaceId, detail.entityId || entityId);
      const bytes = Uint8Array.from(atob(dataBase64), (char) => char.charCodeAt(0));
      revokeInvoiceObjectUrl();
      invoiceObjectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
      frame.innerHTML = `<iframe src="${invoiceObjectUrl}" title="Invoice preview"></iframe>`;
      frame.dataset.loaded = "true";
      frame.hidden = false;
      button.textContent = "Hide Invoice";
    } catch (loadError) {
      frame.innerHTML = `<div class="transactionDetailEmpty">${escapeHtml(loadError?.message || "Could not load the invoice file.")}</div>`;
      frame.hidden = false;
      button.textContent = "Preview Invoice";
    } finally {
      button.disabled = false;
    }
  });
  overlay.querySelector("[data-transaction-detail-close]")?.addEventListener("click", revokeInvoiceObjectUrl);
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) revokeInvoiceObjectUrl();
  });

  body.querySelectorAll("[data-linked-transaction-reference]").forEach((button) => {
    button.addEventListener("click", () => openTransactionDetailDrawer({
      workspaceId,
      transactionReference: button.dataset.linkedTransactionReference,
      trigger: button,
      services,
      branding,
      canExport,
    }));
  });
  renderTab("lineItems");
}

function renderSummaryCards(cards = []) {
  if (!cards.length) return "";
  return `<section class="transactionDetailCards">${cards.map((card) => `<article><span>${escapeHtml(card.label || card.key || "Summary")}</span><strong>${escapeHtml(formatTransactionDetailValue(card.value, card.type))}</strong></article>`).join("")}</section>`;
}

function renderLineItems(rows = [], columns = []) {
  if (!rows.length) return renderEmpty("No line items were recorded for this transaction.");
  return renderTable(rows, columns);
}

function renderStockMovements(rows = []) {
  if (!rows.length) return renderEmpty("No stock movements were recorded for this transaction.");
  const columns = [
    { key: "occurredAt", label: "Date and Time", type: "datetime" },
    { key: "movementType", label: "Movement" },
    { key: "itemName", label: "Item" },
    { key: "locationName", label: "Location" },
    { key: "sourceLocationName", label: "From Location" },
    { key: "destinationLocationName", label: "To Location" },
    { key: "quantity", label: "Quantity", type: "number" },
    { key: "unitCost", label: "Unit Cost", type: "money" },
    { key: "value", label: "Value", type: "money" },
  ];
  return renderTable(rows, columns);
}

function renderAuditTrail(rows = []) {
  if (!rows.length) return renderEmpty("No audit events were recorded for this transaction.");
  return `<ol class="transactionDetailTimeline">${rows.map((row) => `<li><span></span><div><strong>${escapeHtml(humanize(row.action || "Transaction updated"))}</strong><p>${escapeHtml(row.actorName || row.actorEmail || "System")} · ${escapeHtml(formatTransactionDetailValue(row.createdAt, "datetime"))}</p></div></li>`).join("")}</ol>`;
}

function renderTable(rows = [], columns = []) {
  const safeColumns = columns.filter((column) => column?.key);
  return `<div class="transactionDetailTableWrap"><table class="transactionDetailTable"><thead><tr>${safeColumns.map((column) => {
    const headerNumericClass = column.type === "money" || column.type === "number" ? "is-numeric" : "";
    return `<th class="${headerNumericClass}">${escapeHtml(column.label || humanize(column.key))}</th>`;
  }).join("")}</tr></thead><tbody>${rows.map((row) => {
    const direction = String(row.varianceDirection || "").toLowerCase();
    const rowClass = direction === "positive"
      ? "is-positive-variance"
      : direction === "negative"
        ? "is-negative-variance"
        : direction === "none"
          ? "is-zero-variance"
          : "";
    return `<tr class="${rowClass}">${safeColumns.map((column) => {
      const numericClass = column.type === "money" || column.type === "number" ? "is-numeric" : "";
      const varianceClass = /variance/i.test(column.key) && direction ? `is-${direction}-variance-cell` : "";
      return `<td class="${[numericClass, varianceClass].filter(Boolean).join(" ")}">${escapeHtml(formatTransactionDetailValue(row[column.key], column.type))}</td>`;
    }).join("")}</tr>`;
  }).join("")}</tbody></table></div>`;
}

function renderEmpty(message) {
  return `<div class="transactionDetailEmpty">${escapeHtml(message)}</div>`;
}

function renderDetailError(overlay, error) {
  const subtitle = overlay.querySelector("[data-transaction-detail-subtitle]");
  const body = overlay.querySelector("[data-transaction-detail-body]");
  if (subtitle) subtitle.textContent = "Unable to load transaction";
  if (body) body.innerHTML = `<div class="transactionDetailError" role="alert"><strong>Transaction failed to load</strong><p>${escapeHtml(error?.message || "Unknown transaction error.")}</p></div>`;
}

function humanize(value = "") {
  return String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function trapFocus(event, container) {
  const focusable = [...container.querySelectorAll('button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
