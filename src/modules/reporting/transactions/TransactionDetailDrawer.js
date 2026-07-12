import { escapeHtml } from "../engine/formatters.js";
import { fetchTransactionDetail } from "./transactionDetailService.js";
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
    .then((detail) => renderLoadedDetail(overlay, detail, { branding, canExport, workspaceId, services }))
    .catch((error) => renderDetailError(overlay, error));
  return overlay;
}

function renderLoadedDetail(overlay, detail = {}, { branding = {}, canExport = true, workspaceId = "", services = {} } = {}) {
  const definition = getTransactionDetailDefinition(detail.entityType);
  const title = overlay.querySelector("#transactionDetailTitle");
  const subtitle = overlay.querySelector("[data-transaction-detail-subtitle]");
  const body = overlay.querySelector("[data-transaction-detail-body]");
  if (title) title.textContent = detail.transactionReference || "Transaction";
  if (subtitle) subtitle.textContent = [definition.label, detail.status, detail.occurredAt || detail.createdAt].filter(Boolean).join(" · ");
  if (!body) return;
  body.innerHTML = `
    <div class="transactionDetailDrawer__toolbar">
      <div class="transactionDetailDrawer__identity">
        <span class="transactionDetailDrawer__type">${escapeHtml(definition.icon)}</span>
        <div><strong>${escapeHtml(detail.title || definition.label)}</strong><span>${escapeHtml((detail.locationNames || []).join(" · ") || "No location label")}</span></div>
      </div>
      ${canExport ? `<div class="transactionDetailDrawer__exports" aria-label="Transaction exports">
        <button type="button" data-transaction-export="csv">CSV</button>
        <button type="button" data-transaction-export="xlsx">XLSX</button>
        <button type="button" data-transaction-export="pdf">PDF</button>
      </div>` : ""}
    </div>
    ${renderSummaryCards(detail.summaryCards)}
    ${renderMetadata(detail)}
    <nav class="transactionDetailTabs" aria-label="Transaction detail sections">
      <button type="button" class="is-active" data-transaction-tab="lineItems">Line Items <span>${(detail.lineItems || []).length}</span></button>
      <button type="button" data-transaction-tab="stockMovements">Stock Movements <span>${(detail.stockMovements || []).length}</span></button>
      <button type="button" data-transaction-tab="auditTrail">Audit Trail <span>${(detail.auditTrail || []).length}</span></button>
    </nav>
    <div class="transactionDetailPanel" data-transaction-panel></div>`;

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
  body.querySelector('[data-transaction-export="csv"]')?.addEventListener("click", () => downloadTransactionDetailCsv(detail));
  body.querySelector('[data-transaction-export="xlsx"]')?.addEventListener("click", () => downloadTransactionDetailExcel(detail));
  body.querySelector('[data-transaction-export="pdf"]')?.addEventListener("click", () => downloadTransactionDetailPdf(detail, { branding }));
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

function renderMetadata(detail = {}) {
  const rows = [
    ["Status", detail.status],
    ["Date and time", detail.occurredAt || detail.createdAt],
    ["Created by", detail.createdByName || detail.createdBy],
    ["Committed by", detail.committedBy],
  ];
  const metadata = detail.metadata && typeof detail.metadata === "object" ? detail.metadata : {};
  Object.entries(metadata).forEach(([key, value]) => {
    if (value === undefined || value === null || value === "" || typeof value === "object") return;
    rows.push([humanize(key), String(value), key]);
  });
  return `<section class="transactionDetailMetadata">${rows.filter(([, value]) => value).map(([label, value, key = ""]) => {
    const isLinkedTransaction = /transactionReference$/i.test(key) && /^(GRV|CN|MFG|TRF|STK)-/i.test(value);
    return `<div><span>${escapeHtml(label)}</span>${isLinkedTransaction
      ? `<button type="button" class="transactionDetailMetadata__link" data-linked-transaction-reference="${escapeHtml(value)}">${escapeHtml(value)}</button>`
      : `<strong>${escapeHtml(value)}</strong>`}</div>`;
  }).join("")}</section>`;
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
  return `<div class="transactionDetailTableWrap"><table class="transactionDetailTable"><thead><tr>${safeColumns.map((column) => `<th>${escapeHtml(column.label || humanize(column.key))}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => {
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
