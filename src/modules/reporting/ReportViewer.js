import { runReport } from "./engine/reportRunner.js";
import { createReportingDataSet } from "./engine/reportDataMapper.js";
import { text, toArray } from "./engine/grouping.js";
import { escapeHtml } from "./engine/formatters.js";
import { renderReportHeader } from "./tables/ReportHeader.js";
import {
  renderReportFilters,
  readReportFilters,
} from "./tables/ReportFilters.js";
import {
  getReportRowSelectionKey,
  renderReportTable,
} from "./tables/ReportTable.js";
import { renderReportWarningBanner } from "./tables/ReportWarningBanner.js";
import { renderExcludedSummaryBanner } from "./tables/ExcludedSummaryBanner.js";
import { renderReportViewTabs } from "./tables/ReportDrilldownTabs.js";
import { renderReportLoadingState } from "./tables/ReportEmptyState.js";
import { downloadReportCsv } from "./exports/exportCsv.js";
import {
  downloadReportAllViewsExcel,
  downloadReportExcel,
} from "./exports/exportExcel.js";
import { downloadReportPdf } from "./exports/exportPdf.js";
import { getReportDefinition, resolveReportRoute } from "./reports/index.js";
import { clearReportCache } from "./api/reportCache.js";
import { isOrderableStockControlRow } from "./reports/operations/stockControlOrderability.js";
import { bindReportTooltips } from "./tooltips/tooltipBuilder.js";
import { renderSavedViewsControl } from "./savedViews/SavedViewsControl.js";
import { applyDateRangePreset } from "./scheduling/dateRangePresets.js";
import { enhanceReportingSelects } from "./ui/customSelect.js";
import { renderAdvancedReportPresentation } from "./visuals/AdvancedReportVisuals.js";
import {
  paginateReportRows,
  renderReportPagination,
} from "./tables/ReportPagination.js";
import { openTransactionDetailDrawer } from "./transactions/TransactionDetailDrawer.js";
import {
  isTransactionIdColumn,
  normalizeVisibleReportColumns,
  prepareTransactionReportResult,
} from "./transactions/transactionColumnVisibility.js";
import {
  closeReportActionMenu,
  installReportActionMenu,
} from "./ui/reportActionMenu.js";

export function renderReportViewer({
  reportId,
  sourceData = {},
  state = null,
  filters = {},
  services = {},
  workspaceId = "",
  initialView = "",
  initialActiveReportId = "",
  initialSort = null,
  initialVisibleColumns = null,
  initialSavedViewId = "",
  reportGroupId = "",
  onReportSelectionChange,
  preferRedirect = true,
  autoLoadDefault = false,
  allowUrlConfiguration = false,
  onDefaultSavedViewApplied,
  onFiltersChange,
  onRefresh,
  datePresetContext = {},
} = {}) {
  const root = document.createElement("section");
  root.className = "reportViewer";
  const reportLink = allowUrlConfiguration
    ? readReportLinkConfiguration()
    : { view: "", filters: {}, hasExplicitConfiguration: false };
  const dataSet = createReportingDataSet(state || sourceData);
  const route = resolveReportRoute(reportId, { preferRedirect });
  const activeGroupChildId =
    initialActiveReportId || route?.activeReportId || "";
  const effectiveReportId = activeGroupChildId || route?.reportId || reportId;
  const report = getReportDefinition(route?.reportId || reportId);
  if (report?.type === "group") {
    return renderGroupedReportViewer({
      group: report,
      sourceData: dataSet,
      filters: { ...filters, ...reportLink.filters },
      services,
      workspaceId,
      initialActiveReportId: activeGroupChildId,
      initialView: initialView || reportLink.view,
      initialSort,
      initialVisibleColumns,
      initialSavedViewId,
      autoLoadDefault,
      allowUrlConfiguration,
      onDefaultSavedViewApplied,
      onFiltersChange,
      onRefresh,
      datePresetContext,
    });
  }
  const singleReport = getReportDefinition(effectiveReportId) || report;
  let activeFilters = applyDateRangePreset({
    ...filters,
    ...reportLink.filters,
  }, datePresetContext);
  let activeView =
    initialView ||
    reportLink.view ||
    route?.view ||
    getFirstReportView(singleReport);
  let activeSort = initialSort || null;
  let activeVisibleColumns =
    Array.isArray(initialVisibleColumns) && initialVisibleColumns.length
      ? [...initialVisibleColumns]
      : null;
  let activeBulkSelection = new Set();
  let activeSavedViewId = initialSavedViewId || "";
  let activePage = 1;
  let activePageSize = 25;
  let latestRunId = 0;
  let defaultSavedViewApplied =
    !autoLoadDefault || reportLink.hasExplicitConfiguration;
  let latestResult = null;

  const applySavedView = (savedView = {}, result = {}) => {
    activeSavedViewId = savedView.id || activeSavedViewId;
    const nextFilters = applyDateRangePreset({
      ...(savedView.filters || {}),
      dateRangeType:
        savedView.dateRangeType || savedView.filters?.dateRangeType || "custom",
    }, datePresetContext);
    if (
      savedView.reportId &&
      savedView.reportId !== effectiveReportId &&
      typeof onReportSelectionChange === "function"
    ) {
      onReportSelectionChange({ ...savedView, filters: nextFilters });
      return;
    }
    activeFilters = nextFilters;
    activeView = savedView.viewId || activeView;
    activeSort = savedView.sort || null;
    activeVisibleColumns = normalizeVisibleReportColumns(
      result.columns || [],
      Array.isArray(savedView.visibleColumns) && savedView.visibleColumns.length
        ? savedView.visibleColumns
        : null,
    );
    activePage = 1;
    onFiltersChange?.(activeFilters);
    void draw();
  };

  const draw = async ({ reload = true } = {}) => {
    // activeFilters is resolved once at mount (and whenever the filter form is submitted) and
    // otherwise never touched — so a relative preset like "Today" silently goes stale the moment
    // the calendar day rolls over while this viewer instance stays open, even across a manual
    // Refresh: the network call is genuinely fresh, but it queries with yesterday's date range.
    // Re-resolve it from a fresh `now` on every real reload so "Today" always means today.
    if (reload && activeFilters?.dateRangeType && activeFilters.dateRangeType !== "custom") {
      activeFilters = applyDateRangePreset(activeFilters, datePresetContext);
      // A relative preset resolves to the SAME startDate/endDate all day, which is exactly the
      // report cache's key — so re-resolving above does nothing to bypass a stale cache entry from
      // earlier in the day (a prior mount, or a stale result cached before newer data existed).
      // Clear it here too, not just on the explicit Apply/Refresh actions, so a plain page
      // (re)load of a relative-date report is never silently served yesterday's cached rows.
      clearReportCache();
    }
    const runId = ++latestRunId;
    root.__reportActionMenuCleanup?.();
    if (reload || !latestResult) {
      root.innerHTML = "";
      root.append(renderReportLoadingState());
    }

    try {
      const result = prepareTransactionReportResult(
        !reload && latestResult
          ? latestResult
          : await runReport(effectiveReportId, {
              dataSet,
              filters: activeFilters,
              view: activeView,
              sort: activeSort,
              services,
              workspaceId,
            }),
      );
      if (reload || !latestResult) latestResult = result;
      if (runId !== latestRunId) return;
      activeView = result.view;
      activeVisibleColumns = normalizeVisibleReportColumns(
        result.columns || [],
        activeVisibleColumns,
      );
      const displayResult = {
        ...result,
        columns: (result.columns || []).filter((column) =>
          activeVisibleColumns.includes(column.key),
        ),
      };
      const pagination = paginateReportRows(
        displayResult.rows,
        activePage,
        activePageSize,
      );
      activePage = pagination.page;
      activePageSize = pagination.pageSize;
      const pagedDisplayResult = { ...displayResult, rows: pagination.rows };
      root.innerHTML = "";
      const reportHeader = renderReportHeader(result, {
        showRefresh: typeof onRefresh === "function",
        filters: activeFilters,
        canExport: services?.reportingPermissions?.canExportReports !== false,
      });
      const reportingPermissions = services?.reportingPermissions || {};
      const actionMount = reportHeader.querySelector(
        "[data-report-actions-custom]",
      );
      actionMount?.append(renderSavedViewsControl({
          workspaceId,
          reportGroupId,
          reportId: effectiveReportId,
          viewId: result.view,
          canSavePersonal: reportingPermissions.canSavePersonalViews !== false,
          canSaveWorkspace: reportingPermissions.canSaveWorkspaceViews === true,
          initialActiveSavedViewId: activeSavedViewId,
          getConfiguration: () => ({
            reportId: effectiveReportId,
            viewId: activeView,
            filters: activeFilters,
            sort: activeSort,
            visibleColumns: [...activeVisibleColumns],
            dateRangeType: activeFilters.dateRangeType || "custom",
          }),
          onLoad: (savedView) => applySavedView(savedView, result),
          onDefaultAvailable: (savedView) => {
            if (defaultSavedViewApplied) return;
            defaultSavedViewApplied = true;
            onDefaultSavedViewApplied?.(savedView);
            applySavedView(savedView, result);
          },
        }));
      actionMount?.append(renderColumnVisibilityControl(
          result.columns || [],
          activeVisibleColumns,
          { embedded: true },
        ));
      root.append(reportHeader);
      root.append(renderReportViewTabs(result.report, result.view));
      const filterOptions = deriveReportFilterOptions(dataSet, result.rows, services?.reportingPermissions || {});
      root.append(
        renderReportFilters({
          filters: activeFilters,
          locations: filterOptions.locations,
          categories: filterOptions.categories,
          sources: filterOptions.sources,
          paymentMethods: filterOptions.paymentMethods,
          statuses: filterOptions.statuses,
          menuCategories: filterOptions.menuCategories,
          menuItems: filterOptions.menuItems,
          inventoryCategories: filterOptions.inventoryCategories,
          inventoryItems: filterOptions.inventoryItems,
          modifierGroups: filterOptions.modifierGroups,
          modifierTypes: filterOptions.modifierTypes,
          modifierNames: filterOptions.modifierNames,
          stockDeductionStatuses: filterOptions.stockDeductionStatuses,
          yocoCategories: filterOptions.yocoCategories,
          recipeStatuses: filterOptions.recipeStatuses,
          riskStatuses: filterOptions.riskStatuses,
          warningSeverities: filterOptions.warningSeverities,
          suppliers: filterOptions.suppliers,
          itemTypes: filterOptions.itemTypes,
          users: filterOptions.users,
          actions: filterOptions.actions,
          entityTypes: filterOptions.entityTypes,
          entityNames: filterOptions.entityNames,
          config: resolveFilterConfig(result.report, result.view),
        }),
      );
      root.append(renderReportWarningBanner(result.warnings));
      root.append(renderExcludedSummaryBanner(result.excluded, result.excluded?.includedOrderCount ?? result.rows.length));
      if (
        result.presentation &&
        (result.presentation.summaryCards?.length ||
          result.presentation.visuals?.length ||
          result.presentation.explanation)
      ) {
        root.append(renderAdvancedReportPresentation(result.presentation));
      }
      const bulkLowStock = isBulkLowStockReport(result);
      if (!bulkLowStock) activeBulkSelection = new Set();
      if (bulkLowStock) {
        root.append(
          renderLowStockBulkActions(
            result,
            activeBulkSelection,
          ),
        );
      }
      root.append(
        renderReportTable(pagedDisplayResult, {
          selectableRows: bulkLowStock,
          selectedRowKeys: [...activeBulkSelection],
          isRowSelectable: bulkLowStock ? isOrderableStockControlRow : undefined,
        }),
      );
      root.append(renderReportPagination(pagination));

      enhanceReportingSelects(root);
      bindReportTooltips(root);
      installReportActionMenu(root);
      if (bulkLowStock) {
        installLowStockBulkActions(root, result, {
          getSelection: () => activeBulkSelection,
          setSelection: (next) => {
            activeBulkSelection = new Set(next);
          },
          services,
        });
      }
      root
        .querySelector('[data-report-export="csv"]')
        ?.addEventListener("click", (event) => {
          closeReportActionMenu(event.currentTarget);
          downloadReportCsv(displayResult, {
            workspaceName: getReportBranding(state || sourceData || dataSet).companyName,
          });
        });
      root
        .querySelector('[data-report-export="xlsx"]')
        ?.addEventListener("click", (event) => {
          closeReportActionMenu(event.currentTarget);
          downloadReportExcel(displayResult, {
            workspaceName: getReportBranding(state || sourceData || dataSet).companyName,
          });
        });
      root
        .querySelector('[data-report-export="all-xlsx"]')
        ?.addEventListener("click", async (event) => {
          closeReportActionMenu(event.currentTarget);
          const views = collectReportViews(singleReport);
          const results = [];
          for (const view of views) {
            results.push(
              prepareTransactionReportResult(
                await runReport(effectiveReportId, {
                  dataSet,
                  filters: activeFilters,
                  view,
                  sort: activeSort,
                  services,
                  workspaceId,
                }),
              ),
            );
          }
          await downloadReportAllViewsExcel(results, {
            workspaceName: getReportBranding(state || sourceData || dataSet).companyName,
          });
        });
      root
        .querySelector('[data-report-export="pdf"]')
        ?.addEventListener("click", (event) => {
          closeReportActionMenu(event.currentTarget);
          const branding = getReportBranding(state || sourceData || dataSet);
          downloadReportPdf(displayResult, {
            branding,
            workspaceName: branding.companyName,
          });
        });
      root
        .querySelector("[data-report-refresh]")
        ?.addEventListener("click", () => {
          // Manual refresh always bypasses the report cache, regardless of whether the app has
          // itself noticed a data change yet — see api/reportCache.js.
          clearReportCache();
          onRefresh?.();
          void draw();
        });
      root
        .querySelector("[data-report-columns-form]")
        ?.addEventListener("submit", (event) => {
          event.preventDefault();
          const selected = [
            ...event.currentTarget.querySelectorAll(
              'input[name="reportColumn"]:checked',
            ),
          ].map((input) => input.value);
          activeVisibleColumns = normalizeVisibleReportColumns(
            result.columns || [],
            selected.length ? selected : null,
          );
          closeReportActionMenu(event.currentTarget);
          void draw({ reload: false });
        });
      root
        .querySelector("[data-report-columns-all]")
        ?.addEventListener("click", () => {
          root
            .querySelectorAll('input[name="reportColumn"]')
            .forEach((input) => {
              input.checked = true;
            });
        });
      const filtersForm = root.querySelector(".reportFilters");
      installReportFilterInteractions(filtersForm);
      filtersForm?.addEventListener("submit", (event) => {
        event.preventDefault();
        activeFilters = applyDateRangePreset(
          readReportFilters(event.currentTarget),
          datePresetContext,
        );
        activePage = 1;
        onFiltersChange?.(activeFilters);
        // A relative preset like "Today" resolves to the SAME query (same startDate/endDate) every
        // time it's applied within the same calendar day — which is exactly the report cache's key.
        // Without clearing it here, clicking Apply on an already-cached preset silently replays
        // whatever was cached from the very first time it was tried, no matter how much new data
        // has since appeared, and the only way out was the separate Refresh button. An explicit
        // Apply is just as much a deliberate "show me current data" action as Refresh is.
        clearReportCache();
        void draw();
      });
      root
        .querySelector(".reportViewTabs")
        ?.addEventListener("click", (event) => {
          const button = event.target.closest("[data-report-view]");
          if (!button) return;
          activeView = button.dataset.reportView;
          activeSort = null;
          activeVisibleColumns = null;
          activeBulkSelection = new Set();
          activePage = 1;
          void draw();
        });
      root
        .querySelector("[data-report-page-size]")
        ?.addEventListener("change", (event) => {
          activePageSize = Number(event.currentTarget.value) || 25;
          activePage = 1;
          void draw({ reload: false });
        });
      root
        .querySelector(".reportPagination")
        ?.addEventListener("click", (event) => {
          const button = event.target.closest("[data-report-page]");
          if (!button || button.disabled) return;
          const action = button.dataset.reportPage;
          if (action === "first") activePage = 1;
          if (action === "previous") activePage = Math.max(1, activePage - 1);
          if (action === "next")
            activePage = Math.min(pagination.pageCount, activePage + 1);
          if (action === "last") activePage = pagination.pageCount;
          void draw({ reload: false });
        });
      root.querySelector(".reportTable")?.addEventListener("click", (event) => {
        const transactionButton = event.target.closest(
          "[data-report-transaction-id]",
        );
        if (transactionButton) {
          event.preventDefault();
          event.stopPropagation();
          const transactionReference =
            transactionButton.dataset.reportTransactionId || "";
          const detail = {
            transactionReference,
            entityType: transactionButton.dataset.reportTransactionType || "",
            entityId: transactionButton.dataset.reportTransactionEntityId || "",
            reportId: result.report?.id || result.reportId || "",
            view: result.view || activeView,
          };
          openTransactionDetailDrawer({
            workspaceId,
            transactionReference,
            entityType: detail.entityType,
            entityId: detail.entityId,
            trigger: transactionButton,
            services,
            branding: getReportBranding(state || sourceData || dataSet),
            canExport: services?.reportingPermissions?.canExportReports !== false,
          });
          if (typeof services?.reporting?.onTransactionSelect === "function") {
            services.reporting.onTransactionSelect(detail);
          }
          root.dispatchEvent(
            new CustomEvent("reporttransactionselect", {
              bubbles: true,
              detail,
            }),
          );
          return;
        }
        const shortcut = event.target.closest("[data-report-shortcut]");
        if (shortcut) {
          event.preventDefault();
          event.stopPropagation();
          handleReportShortcut(shortcut.dataset.reportShortcut, services);
          return;
        }
        const button = event.target.closest("[data-sort-key]");
        if (!button) return;
        activeSort = {
          key: button.dataset.sortKey,
          direction: button.dataset.sortDirection || "asc",
        };
        activePage = 1;
        void draw();
      });
    } catch (error) {
      if (runId !== latestRunId) return;
      root.innerHTML = "";
      const failure = document.createElement("div");
      failure.className = "reportWarningBanner";
      failure.setAttribute("role", "alert");
      failure.innerHTML = `<strong>Report failed to load</strong><p>${escapeHtml(error?.message || "Unknown reporting error.")}</p>`;
      root.append(failure);
    }
  };

  void draw();
  return root;
}

function renderGroupedReportViewer({
  group = {},
  sourceData = {},
  filters = {},
  services = {},
  workspaceId = "",
  initialActiveReportId = "",
  initialView = "",
  initialSort = null,
  initialVisibleColumns = null,
  initialSavedViewId = "",
  autoLoadDefault = false,
  allowUrlConfiguration = false,
  onDefaultSavedViewApplied,
  onFiltersChange,
  onRefresh,
  datePresetContext = {},
} = {}) {
  const root = document.createElement("section");
  root.className = "reportViewer reportViewer--grouped";
  const childReports = (group.reports || []).filter((item) =>
    getReportDefinition(item.id),
  );
  let sharedFilters = applyDateRangePreset({ ...filters }, datePresetContext);
  let pendingView = initialView || "";
  let pendingSort = initialSort;
  let pendingVisibleColumns = initialVisibleColumns;
  let pendingSavedViewId = initialSavedViewId;
  let groupDefaultApplied = false;
  let activeChildId = childReports.some(
    (item) => item.id === initialActiveReportId,
  )
    ? initialActiveReportId
    : childReports[0]?.id || "";

  const draw = () => {
    root.innerHTML = "";
    const selected =
      childReports.find((item) => item.id === activeChildId) || childReports[0];
    activeChildId = selected?.id || activeChildId;
    const toggle = document.createElement("div");
    toggle.className = "reportGroupToggle";
    toggle.innerHTML = `
      <div class="reportViewTabs reportViewTabs--group" role="tablist" aria-label="${escapeHtml(group.title || "Report group")}">
        ${childReports
          .map(
            (item) => `
          <button type="button" role="tab" class="${item.id === activeChildId ? "is-active" : ""}" data-report-group-child="${escapeHtml(item.id)}" aria-selected="${item.id === activeChildId ? "true" : "false"}">
            ${escapeHtml(item.label || getReportDefinition(item.id)?.title || item.id)}
          </button>
        `,
          )
          .join("")}
      </div>
    `;
    root.append(toggle);

    const childSlot = document.createElement("div");
    childSlot.className = "reportGroupToggle__body";
    childSlot.append(
      renderReportViewer({
        reportId: activeChildId,
        sourceData,
        filters: sharedFilters,
        services,
        workspaceId,
        reportGroupId: group.id || "",
        initialView: pendingView,
        initialSort: pendingSort,
        initialVisibleColumns: pendingVisibleColumns,
        initialSavedViewId: pendingSavedViewId,
        autoLoadDefault: autoLoadDefault && !groupDefaultApplied,
        allowUrlConfiguration,
        onDefaultSavedViewApplied: () => {
          groupDefaultApplied = true;
          onDefaultSavedViewApplied?.();
        },
        onReportSelectionChange: (savedView) => {
          sharedFilters = applyDateRangePreset({
            ...(savedView.filters || {}),
            dateRangeType: savedView.dateRangeType || "custom",
          }, datePresetContext);
          pendingView = savedView.viewId || "";
          pendingSort = savedView.sort || null;
          pendingVisibleColumns = savedView.visibleColumns || null;
          pendingSavedViewId = savedView.id || "";
          activeChildId = savedView.reportId || activeChildId;
          groupDefaultApplied = true;
          onFiltersChange?.(sharedFilters);
          draw();
        },
        preferRedirect: false,
        onFiltersChange: (nextFilters) => {
          sharedFilters = { ...nextFilters };
          onFiltersChange?.(sharedFilters);
        },
        onRefresh,
        datePresetContext,
      }),
    );
    root.append(childSlot);

    root
      .querySelector(".reportViewTabs--group")
      ?.addEventListener("click", (event) => {
        const button = event.target.closest("[data-report-group-child]");
        if (!button) return;
        activeChildId = button.dataset.reportGroupChild;
        pendingView = "";
        pendingSort = null;
        pendingVisibleColumns = null;
        pendingSavedViewId = "";
        groupDefaultApplied = false;
        draw();
      });
  };

  draw();
  return root;
}

export function getFirstReportView(report = {}) {
  const firstAvailable = Array.isArray(report?.availableViews)
    ? report.availableViews.find(Boolean)
    : "";
  return firstAvailable || report?.defaultView || "ledger";
}

function readReportLinkConfiguration() {
  if (typeof window === "undefined")
    return { view: "", filters: {}, hasExplicitConfiguration: false };
  const params = new URLSearchParams(window.location.search);
  const filters = {};
  const supportedFilters = [
    "search",
    "dateRangeType",
    "time",
    'locationId',
    'locationIds',
    'locations',
    "category",
    "source",
    "sourceType",
    "paymentMethod",
    "status",
    "receiptNumber",
    "menuCategory",
    "menuItemId",
    "inventoryCategory",
    "inventoryItemId",
    "modifierGroupId",
    "modifierType",
    "modifierName",
    "stockDeductionStatus",
    "yocoCategory",
    "recipeStatus",
    "riskStatus",
    "warningSeverity",
    "supplierId",
    "itemType",
    "onlyCritical",
    "onlyBelowPar",
    "missingSupplier",
    "missingCost",
    "user",
    "action",
    "entityType",
    "entityName",
  ];
  const arrayFilters = new Set(['locationIds', 'locations']);
  supportedFilters.forEach((key) => {
    const value = params.get(key);
    if (value === null || value === "") return;
    filters[key] = arrayFilters.has(key)
      ? value.split(',').map((entry) => entry.trim()).filter(Boolean)
      : value;
  });
  const startDate = params.get('from') || params.get('startDate') || "";
  const endDate = params.get('to') || params.get('endDate') || "";
  if (startDate) filters.startDate = startDate;
  if (endDate) filters.endDate = endDate;
  if ((startDate || endDate) && !filters.dateRangeType)
    filters.dateRangeType = "custom";
  const view = params.get('view') || "";
  return {
    view,
    filters,
    hasExplicitConfiguration: Boolean(view || Object.keys(filters).length),
  };
}

function renderColumnVisibilityControl(
  columns = [],
  visibleColumns = [],
  { embedded = false } = {},
) {
  const visible = new Set(visibleColumns || []);
  const section = document.createElement("section");
  section.className = `reportColumnVisibility${embedded ? " reportColumnVisibility--embedded reportActionMenu__section" : ""}`;
  const options = columns
    .map(
      (column) => `
        <label><input type="checkbox" name="reportColumn" value="${escapeHtml(column.key)}" ${visible.has(column.key) ? "checked" : ""} ${isTransactionIdColumn(column) ? 'disabled data-required-report-column="true"' : ""} /><span>${escapeHtml(column.label || column.key)}${isTransactionIdColumn(column) ? " · Required" : ""}</span></label>
      `,
    )
    .join("");
  const form = `
    <form data-report-columns-form>
      ${embedded ? '<div class="reportColumnVisibility__toolbar"><button type="button" data-report-columns-all>Select all</button></div>' : `<header><div><span>Columns</span><strong>Visible columns · ${visible.size}/${columns.length}</strong></div><button type="button" data-report-columns-all>Select all</button></header>`}
      <div class="reportColumnVisibility__options">${options}</div>
      <button type="submit">Apply columns</button>
    </form>
  `;
  section.innerHTML = embedded
    ? `<details class="reportColumnVisibility__details"><summary><span><small>Columns</small><strong>Visible columns · ${visible.size}/${columns.length}</strong></span><span class="reportColumnVisibility__chevron" aria-hidden="true">⌄</span></summary>${form}</details>`
    : `<details><summary>Columns <span>${visible.size}/${columns.length}</span></summary>${form}</details>`;
  return section;
}

function isBulkLowStockReport(result = {}) {
  const reportId = text(result.report?.id || result.id).toLowerCase();
  const view = text(result.view).toLowerCase();
  return (
    reportId === "stock_control" &&
    ["item_detail", "reorder_detail"].includes(view)
  );
}

function renderLowStockBulkActions(
  result = {},
  selectedKeys = new Set(),
) {
  const rows = getBulkOrderRows(result.rows);
  const selectedCount = rows.filter((row, index) =>
    selectedKeys.has(getReportRowSelectionKey(row, index)),
  ).length;
  return htmlToNode(`
    <section class="reportBulkActions" aria-label="Stock control purchase order actions">
      <div class="reportBulkActions__title">
        <strong>Create Purchase Order</strong>
        <span>${escapeHtml(String(selectedCount))} selected from ${escapeHtml(String(rows.length))} orderable item${rows.length === 1 ? "" : "s"}</span>
      </div>
      <div class="reportBulkActions__controls">
        <button type="button" class="reportBulkActions__button" data-report-lowstock-select-all>Select all orderable items</button>
        <span class="reportBulkActions__hint">Choose the supplier in the purchase order. Manufactured items remain visible but cannot be ordered.</span>
        <button type="button" class="reportBulkActions__primary" data-report-lowstock-create ${selectedCount ? "" : "disabled"}>Send to Purchase Order</button>
      </div>
    </section>
  `);
}

function installLowStockBulkActions(root, result = {}, state = {}) {
  const rows = getBulkOrderRows(result.rows);
  const keyForIndex = (index) => getReportRowSelectionKey(rows[index], index);
  const updateVisualState = () => {
    const selected = state.getSelection();
    const selectedCount = rows.filter((row, index) =>
      selected.has(getReportRowSelectionKey(row, index)),
    ).length;
    root.querySelectorAll("[data-report-select-row]").forEach((input) => {
      input.checked = selected.has(text(input.dataset.reportSelectRow));
    });
    const allVisible =
      rows.length > 0 &&
      rows.every((row, index) =>
        selected.has(getReportRowSelectionKey(row, index)),
      );
    root.querySelectorAll("[data-report-select-all]").forEach((input) => {
      input.checked = allVisible;
    });
    root
      .querySelector(".reportBulkActions__title span")
      ?.replaceChildren(
        document.createTextNode(
          `${selectedCount} selected from ${rows.length} orderable item${rows.length === 1 ? "" : "s"}`,
        ),
      );
    const createButton = root.querySelector("[data-report-lowstock-create]");
    if (createButton) createButton.disabled = selectedCount === 0;
  };

  root.querySelectorAll("[data-report-select-row]").forEach((input) => {
    input.addEventListener("change", () => {
      const selected = new Set(state.getSelection());
      const key = text(input.dataset.reportSelectRow);
      if (input.checked) selected.add(key);
      else selected.delete(key);
      state.setSelection(selected);
      updateVisualState();
    });
  });

  root
    .querySelectorAll(
      "[data-report-select-all], [data-report-lowstock-select-all]",
    )
    .forEach((control) => {
      control.addEventListener("click", (event) => {
        if (control.matches('input[type="checkbox"]')) return;
        event.preventDefault();
        const selected = new Set(
          rows.map((row, index) => getReportRowSelectionKey(row, index)),
        );
        state.setSelection(selected);
        updateVisualState();
      });
      control.addEventListener("change", () => {
        if (!control.matches('input[type="checkbox"]')) return;
        const selected = new Set(state.getSelection());
        rows.forEach((row, index) => {
          const key = getReportRowSelectionKey(row, index);
          if (control.checked) selected.add(key);
          else selected.delete(key);
        });
        state.setSelection(selected);
        updateVisualState();
      });
    });

  root
    .querySelector("[data-report-lowstock-create]")
    ?.addEventListener("click", (event) => {
      event.preventDefault();
      const selected = state.getSelection();
      const selectedRows = rows.filter((row, index) =>
        selected.has(keyForIndex(index)),
      );
      if (!selectedRows.length) return;
      handleReportShortcut(
        encodeURIComponent(
          JSON.stringify({
            action: "createPurchaseOrder",
            source: "stock_control_bulk",
            supplierId: "",
            supplierName: "",
            items: selectedRows.map((row) => buildLowStockOrderPayload(row)),
          }),
        ),
        state.services,
      );
    });
}

function getBulkOrderRows(rows = []) {
  return toArray(rows).filter(isOrderableStockControlRow);
}

function buildLowStockOrderPayload(row = {}) {
  return {
    itemId: text(
      row.itemId || row.stockItemId || row.inventoryItemId || row.sourceId,
    ),
    stockItemId: text(
      row.stockItemId || row.itemId || row.inventoryItemId || row.sourceId,
    ),
    itemName: text(
      row.itemName || row.stockItemName || row.inventoryItemName || row.name,
    ),
    locationId: text(row.locationId),
    locationName: text(row.locationName),
    supplierId: '',
    supplierName: '',
    requiredQty: safeNumber(row.requiredQty || row.reorderQty),
    purchaseUom: text(row.purchaseUom || row.baseUom || row.unit),
    purchaseUomQty: safeNumber(
      row.purchaseUomQty || row.requiredQty || row.reorderQty,
    ) || 1,
    unitCostExVat: safeNumber(
      row.unitCostExVat || row.lastPurchaseCost || row.unitCost,
    ),
    parLevel: safeNumber(row.parLevel),
    currentStock: safeNumber(row.currentStock),
    lowStockThreshold: safeNumber(row.lowStockThreshold || row.threshold),
  };
}

function htmlToNode(html = "") {
  const template = document.createElement("template");
  template.innerHTML = html.trim();
  return (
    template.content.firstElementChild || document.createDocumentFragment()
  );
}

function safeNumber(value) {
  const numeric = Number(value || 0);
  return Number.isFinite(numeric) ? numeric : 0;
}

function handleReportShortcut(encodedPayload = "", services = {}) {
  let payload = {};
  try {
    payload = JSON.parse(decodeURIComponent(encodedPayload || "%7B%7D")) || {};
  } catch {
    payload = {};
  }
  const actions =
    services?.reportingActions || services?.reporting?.actions || {};
  const action = text(payload.action);
  if (action === "openRecipe") return actions.openRecipe?.(payload);
  if (action === "createPurchaseOrder")
    return actions.createPurchaseOrder?.(payload);
  if (action === "openStockItem") return actions.openStockItem?.(payload);
  if (action === "openMenuItem") return actions.openMenuItem?.(payload);
  if (action === "openSuppliers") return actions.openSuppliers?.(payload);
}

function resolveFilterConfig(report = {}, view = "") {
  const config = report.filterConfig;
  if (!config) return null;
  if (Array.isArray(config)) return config;
  return config[view] || config.default || null;
}

function deriveReportFilterOptions(dataSet = {}, rows = [], reportingPermissions = {}) {
  return {
    locations: deriveLocations(dataSet, rows, reportingPermissions.locations),
    categories: deriveCategories(dataSet, rows),
    sources: deriveSources(rows),
    paymentMethods: uniqueValues(rows, (row) => row.paymentMethod),
    statuses: uniqueValues(rows, (row) => row.status),
    menuCategories: uniqueValues(rows, (row) => row.menuCategory),
    menuItems: uniqueObjects(
      rows,
      (row) => row.menuItemId || row.menuItemName,
      (row) => row.menuItemName,
    ),
    inventoryCategories: uniqueValues(
      rows,
      (row) => row.inventoryCategoryName || row.inventoryCategory,
    ),
    inventoryItems: uniqueObjects(
      rows,
      (row) =>
        row.inventoryItemId ||
        row.itemId ||
        row.stockItemId ||
        row.inventoryIngredient ||
        row.inventoryItemName ||
        row.itemName,
      (row) =>
        row.inventoryIngredient ||
        row.inventoryItemName ||
        row.itemName ||
        row.stockItemName,
    ),
    modifierGroups: uniqueObjects(
      rows,
      (row) => row.modifierGroupId || row.modifierGroupName,
      (row) => row.modifierGroupName || row.modifierGroupId,
    ),
    modifierTypes: uniqueValues(rows, (row) => row.modifierType),
    modifierNames: uniqueValues(rows, (row) => row.modifierName),
    stockDeductionStatuses: uniqueValues(
      rows,
      (row) => row.stockDeductionStatus,
    ),
    yocoCategories: uniqueValues(rows, (row) => row.yocoCategory),
    recipeStatuses: uniqueValues(rows, (row) => row.recipeStatus),
    riskStatuses: uniqueValues(rows, (row) => row.riskStatus),
    warningSeverities: uniqueValues(rows, (row) => row.severity),
    suppliers: uniqueObjects(
      rows,
      (row) => row.supplierId || row.supplierName,
      (row) => row.supplierName || row.supplierId,
    ),
    itemTypes: uniqueValues(rows, (row) => row.itemType),
    users: uniqueValues(
      rows,
      (row) => row.user || row.createdBy || row.createdByName,
    ),
    actions: uniqueValues(rows, (row) => row.action),
    entityTypes: uniqueValues(rows, (row) => row.entityType),
    entityNames: uniqueValues(rows, (row) => row.entityName),
  };
}

function uniqueValues(rows = [], selector) {
  return Array.from(
    new Set((rows || []).map(selector).map(text).filter(Boolean)),
  ).sort();
}

function uniqueObjects(rows = [], getValue, getLabel) {
  const seen = new Map();
  (rows || []).forEach((row) => {
    const value = text(getValue(row));
    const label = text(getLabel(row) || value);
    if (!value || seen.has(value)) return;
    seen.set(value, { value, label });
  });
  return [...seen.values()].sort((a, b) => a.label.localeCompare(b.label));
}

function deriveSources(rows = []) {
  const fromRows = (rows || [])
    .map((row) => row.source || row.sourceType)
    .filter(Boolean);
  const fromMeta = extractFilterOptions(rows, "sources").map(
    (source) => source.label || source.value || source,
  );
  return Array.from(
    new Set([...fromRows, ...fromMeta].map(text).filter(Boolean)),
  ).sort();
}

function deriveCategories(dataSet = {}, rows = []) {
  const fromLedger = (rows || [])
    .map((row) => row.category || row.categoryName)
    .filter(Boolean);
  const fromStock = (dataSet.stockItems || [])
    .map((item) => item.category || item.stockCategory)
    .filter(Boolean);
  const fromMeta = extractFilterOptions(rows, "categories").map(
    (category) => category.label || category.value || category,
  );
  return Array.from(
    new Set(
      [...fromLedger, ...fromStock, ...fromMeta].map(text).filter(Boolean),
    ),
  ).sort();
}

function deriveLocations(dataSet = {}, rows = [], authoritativeLocations = undefined) {
  const sourceLocations = Array.isArray(authoritativeLocations)
    ? authoritativeLocations
    : [
        ...(dataSet.locations || []),
        ...extractFilterOptions(rows, "locations"),
        ...(rows || []).map((row) => ({
          id: row.locationId || row.locationName,
          name: row.locationName || row.locationId,
        })),
      ];
  const seenIds = new Set();
  const seenNames = new Set();
  const output = [];

  for (const location of sourceLocations) {
    const id = text(
      location.id ||
        location.locationId ||
        location.location_id ||
        location.value ||
        location.key,
    );
    const name = text(
      location.displayName ||
        location.display_name ||
        location.name ||
        location.locationName ||
        location.label ||
        id,
    );
    if (!id && !name) continue;
    const idKey = normalizeLocationIdentity(id);
    const nameKey = normalizeLocationIdentity(name);
    if ((idKey && seenIds.has(idKey)) || (nameKey && seenNames.has(nameKey))) continue;
    output.push({ ...location, id: id || name, name: name || id });
    if (idKey) seenIds.add(idKey);
    if (nameKey) seenNames.add(nameKey);
  }
  return output.sort((left, right) => text(left.name).localeCompare(text(right.name)));
}

function normalizeLocationIdentity(value = "") {
  return text(value).normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function extractFilterOptions(rows = [], key = "") {
  for (const row of rows || []) {
    const direct = row?.__apiMeta?.filterOptions?.[key];
    if (Array.isArray(direct)) return direct;
    const metaRows = row?.__meta?.ledgerRows || row?.__meta?.wastageRows || [];
    for (const metaRow of metaRows) {
      const nested = metaRow?.__apiMeta?.filterOptions?.[key];
      if (Array.isArray(nested)) return nested;
    }
  }
  return [];
}

function collectReportViews(report = {}) {
  const views =
    Array.isArray(report.availableViews) && report.availableViews.length
      ? report.availableViews
      : [report.defaultView || "summary"];
  return Array.from(new Set(views.filter(Boolean)));
}

function getReportBranding(source = {}) {
  const settings =
    source?.settings?.draft ||
    source?.settings?.values ||
    source?.settings ||
    source?.source?.settings ||
    {};
  const workspace = source?.workspace || source?.source?.workspace || {};
  return {
    companyName:
      workspace.siteName ||
      workspace.name ||
      settings.siteName ||
      settings.workspaceName ||
      "Kitchen Cost Pro",
    logoDataUrl:
      settings.restaurantLogoDataUrl ||
      settings.logoDataUrl ||
      settings.customerLogoDataUrl ||
      "",
  };
}

export default renderReportViewer;

function installReportFilterInteractions(form) {
  if (!form) return;

  const closeAll = (except = null) => {
    form
      .querySelectorAll(
        "[data-report-time-picker].is-open, [data-report-date-range].is-open",
      )
      .forEach((node) => {
        if (node === except) return;
        node.classList.remove("is-open");
        node
          .querySelector("[data-report-time-button], [data-report-date-button]")
          ?.setAttribute("aria-expanded", "false");
      });
  };

  installTimePickers(form, closeAll);
  installDateRangePickers(form, closeAll);
  installDatePresetToggle(form);

  form.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAll();
  });

  document.addEventListener(
    "click",
    (event) => {
      if (!form.isConnected) return;
      if (!form.contains(event.target)) closeAll();
    },
    { capture: true },
  );
}

function installDatePresetToggle(form) {
  const input = form.querySelector('[name="dateRangeType"]');
  const customRange = form.querySelector("[data-report-date-range]");
  if (!input || !customRange) return;
  const sync = () => {
    const isCustom = (input.value || "custom") === "custom";
    customRange.classList.toggle("is-hidden", !isCustom);
    if (!isCustom) customRange.classList.remove("is-open");
  };
  input.addEventListener("change", sync);
  sync();
}

function installTimePickers(form, closeAll) {
  form.querySelectorAll("[data-report-time-picker]").forEach((picker) => {
    const button = picker.querySelector("[data-report-time-button]");
    const input = picker.querySelector("[data-report-time-input]");
    button?.addEventListener("click", (event) => {
      event.preventDefault();
      const isOpen = picker.classList.contains("is-open");
      closeAll(picker);
      picker.classList.toggle("is-open", !isOpen);
      button.setAttribute("aria-expanded", String(!isOpen));
    });
    picker.querySelectorAll("[data-report-time-option]").forEach((option) => {
      option.addEventListener("click", (event) => {
        event.preventDefault();
        if (input)
          input.value =
            option.dataset.reportTimeOption || option.textContent || "";
        picker.classList.remove("is-open");
        button?.setAttribute("aria-expanded", "false");
      });
    });
  });
}

function installDateRangePickers(form, closeAll) {
  form.querySelectorAll("[data-report-date-range]").forEach((picker) => {
    const button = picker.querySelector("[data-report-date-button]");
    const display = picker.querySelector("[data-report-date-display]");
    const startInput = picker.querySelector("[data-report-start-date]");
    const endInput = picker.querySelector("[data-report-end-date]");
    const panel = picker.querySelector("[data-report-date-picker]");
    let cursor = getInitialCalendarMonth(startInput?.value || endInput?.value);
    let pendingStart = startInput?.value || "";

    const redrawCalendar = () => {
      if (!panel) return;
      panel.innerHTML = renderCalendar(
        cursor,
        startInput?.value || "",
        endInput?.value || "",
      );
      panel
        .querySelector("[data-report-calendar-prev]")
        ?.addEventListener("click", (event) => {
          event.preventDefault();
          cursor = new Date(
            Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() - 1, 1),
          );
          redrawCalendar();
        });
      panel
        .querySelector("[data-report-calendar-next]")
        ?.addEventListener("click", (event) => {
          event.preventDefault();
          cursor = new Date(
            Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1),
          );
          redrawCalendar();
        });
      panel.querySelectorAll("[data-report-date-value]").forEach((day) => {
        day.addEventListener("click", (event) => {
          event.preventDefault();
          const value = day.dataset.reportDateValue || "";
          if (!value) return;
          if (!pendingStart || (startInput?.value && endInput?.value)) {
            pendingStart = value;
            if (startInput) startInput.value = value;
            if (endInput) endInput.value = "";
          } else {
            const [from, to] =
              value < pendingStart
                ? [value, pendingStart]
                : [pendingStart, value];
            if (startInput) startInput.value = from;
            if (endInput) endInput.value = to;
            pendingStart = "";
            picker.classList.remove("is-open");
            button?.setAttribute("aria-expanded", "false");
          }
          updateDateRangeDisplay(
            display,
            startInput?.value || "",
            endInput?.value || "",
          );
          redrawCalendar();
        });
      });
      panel
        .querySelector("[data-report-date-clear]")
        ?.addEventListener("click", (event) => {
          event.preventDefault();
          pendingStart = "";
          if (startInput) startInput.value = "";
          if (endInput) endInput.value = "";
          updateDateRangeDisplay(display, "", "");
          redrawCalendar();
        });
    };

    button?.addEventListener("click", (event) => {
      event.preventDefault();
      const isOpen = picker.classList.contains("is-open");
      closeAll(picker);
      picker.classList.toggle("is-open", !isOpen);
      button.setAttribute("aria-expanded", String(!isOpen));
      if (!isOpen) redrawCalendar();
    });

    display?.addEventListener("input", () => {
      const dates =
        String(display.value || "").match(/\d{4}-\d{2}-\d{2}/g) || [];
      if (startInput) startInput.value = dates[0] || "";
      if (endInput) endInput.value = dates[1] || "";
    });
  });
}

function getInitialCalendarMonth(value = "") {
  const match = String(value || "").match(/^(\d{4})-(\d{2})/);
  const now = new Date();
  return match
    ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, 1))
    : new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
}

function renderCalendar(monthDate, selectedStart = "", selectedEnd = "") {
  const year = monthDate.getUTCFullYear();
  const month = monthDate.getUTCMonth();
  const first = new Date(Date.UTC(year, month, 1));
  const startOffset = first.getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const cells = [];
  for (let i = 0; i < startOffset; i += 1)
    cells.push('<span class="reportDatePicker__day is-empty"></span>');
  for (let day = 1; day <= daysInMonth; day += 1) {
    const value = `${year}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const isSelected = value === selectedStart || value === selectedEnd;
    const inRange =
      selectedStart &&
      selectedEnd &&
      value > selectedStart &&
      value < selectedEnd;
    cells.push(
      `<button type="button" class="reportDatePicker__day${isSelected ? " is-selected" : ""}${inRange ? " is-in-range" : ""}" data-report-date-value="${escapeHtml(value)}">${day}</button>`,
    );
  }
  const label = monthDate.toLocaleString("en-ZA", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
  return `
    <span class="reportDatePicker__header">
      <button type="button" data-report-calendar-prev>‹</button>
      <strong>${escapeHtml(label)}</strong>
      <button type="button" data-report-calendar-next>›</button>
    </span>
    <span class="reportDatePicker__weekdays"><span>Sun</span><span>Mon</span><span>Tue</span><span>Wed</span><span>Thu</span><span>Fri</span><span>Sat</span></span>
    <span class="reportDatePicker__grid">${cells.join("")}</span>
    <button type="button" class="reportDatePicker__clear" data-report-date-clear>Clear dates</button>
  `;
}

function updateDateRangeDisplay(display, startDate, endDate) {
  if (!display) return;
  display.value =
    startDate && endDate
      ? `${startDate} → ${endDate}`
      : startDate || endDate || "";
}

export const __reportViewerInternals = {
  getBulkOrderRows,
  buildLowStockOrderPayload,
};
