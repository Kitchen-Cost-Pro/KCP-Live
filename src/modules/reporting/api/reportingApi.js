import { buildReportingEndpoint, buildReportingQuery } from './reportingEndpoints.js';
import { collectCompleteReportPages } from './reportPageLoader.js';
import { getCachedReport, setCachedReport } from './reportCache.js';
import {
  mapDetailedActivityLedgerResponse,
  mapMenuRecipeHealthResponse,
  mapModifierSalesResponse,
  mapInventoryAuditResponse,
  mapStockControlResponse,
  mapSalesFinancialResponse,
  mapSaleStockUsageResponse,
  mapStockTakeAuditResponse
} from './reportingMappers.js';

export async function fetchDetailedActivityLedger({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/detailed-activity', filters);
  const response = await fetchCompleteReportJson(endpoint);
  return mapDetailedActivityLedgerResponse(response);
}

export async function fetchOperationsLedger({ workspaceId, filters } = {}) {
  return fetchDetailedActivityLedger({ workspaceId, filters });
}

// A small summary object (counts + a capped drill-down list), not a paginated row set, so this
// deliberately calls fetchReportJson directly rather than fetchCompleteReportJson/collectCompleteReportPages.
export async function fetchOperationsExcludedSummary({ workspaceId, filters } = {}) {
  return fetchReportJson({
    workspaceId,
    resource: 'reports/operations-excluded',
    query: buildReportingQuery(filters)
  });
}


export async function fetchSalesFinancialRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/sales-financial', filters);
  const response = await fetchCompleteReportJson(endpoint);
  return mapSalesFinancialResponse(response);
}

export async function fetchSaleStockUsageRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/sale-stock-usage', filters);
  const response = await fetchCompleteReportJson(endpoint);
  return mapSaleStockUsageResponse(response);
}

export async function fetchModifierUsageRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/modifier-usage', filters);
  const response = await fetchCompleteReportJson(endpoint);
  return mapSaleStockUsageResponse(response);
}

export async function fetchModifierSalesRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/modifier-sales', filters);
  const response = await fetchCompleteReportJson(endpoint);
  return mapModifierSalesResponse(response);
}

export async function fetchMenuRecipeHealthRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/menu-recipe-health', filters);
  const response = await fetchCompleteReportJson(endpoint);
  return mapMenuRecipeHealthResponse(response);
}

export async function fetchStockTakeAuditRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/stock-take-audit', filters);
  const response = await fetchCompleteReportJson(endpoint);
  return mapStockTakeAuditResponse(response);
}

export async function fetchStockControlRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/stock-control', filters);
  const response = await fetchCompleteReportJson(endpoint);
  return mapStockControlResponse(response);
}


export async function fetchStockOnHandRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/stock-on-hand', filters);
  return fetchCompleteReportJson(endpoint);
}

export async function fetchPurchaseOrderReportRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/purchase-orders', filters);
  return fetchCompleteReportJson(endpoint);
}

export async function fetchGrvLogRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/grv-log', filters);
  return fetchCompleteReportJson(endpoint);
}

export async function fetchCreditNoteReportRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/credit-notes', filters);
  return fetchCompleteReportJson(endpoint);
}

export async function fetchManufacturingTransactionRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/manufacturing-transactions', filters);
  return fetchCompleteReportJson(endpoint);
}

export async function fetchStockTransferTransactionRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/stock-transfer-transactions', filters);
  return fetchCompleteReportJson(endpoint);
}

export async function fetchInventoryAuditRows({ workspaceId, filters } = {}) {
  const endpoint = buildReportingEndpoint(workspaceId, '/inventory-audit', filters);
  const response = await fetchCompleteReportJson(endpoint);
  return mapInventoryAuditResponse(response);
}

export async function fetchReportJson({ workspaceId, resource, query } = {}) {
  const cached = getCachedReport({ workspaceId, resource, query });
  if (cached) return cached;
  const { callCloudflareWorkspaceRoute } = await import('../../../services/cloudflareApi.js');
  const response = await callCloudflareWorkspaceRoute(workspaceId, resource, { query });
  setCachedReport({ workspaceId, resource, query }, response);
  return response;
}

export async function fetchCompleteReportJson(endpoint = {}) {
  const originalQuery = endpoint.query || {};
  if (originalQuery.limit || originalQuery.offset) return fetchReportJson(endpoint);

  return collectCompleteReportPages({
    resource: endpoint.resource,
    baseQuery: originalQuery,
    fetchPage: (query) => fetchReportJson({ ...endpoint, query })
  });
}
