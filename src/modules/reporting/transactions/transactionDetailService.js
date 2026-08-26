import { callCloudflareWorkspaceRoute } from "../../../services/cloudflareApi.js";

export async function fetchTransactionDetail({
  workspaceId,
  transactionReference,
  entityType = "",
  entityId = "",
} = {}) {
  const reference = String(transactionReference || "").trim();
  if (!reference) throw new Error("Transaction ID is required.");
  const response = await callCloudflareWorkspaceRoute(
    workspaceId,
    `reports/transactions/${encodeURIComponent(reference)}`,
    { query: { entityType, entityId } },
  );
  if (!response?.transaction) throw new Error("Transaction detail was not returned.");
  return response.transaction;
}
