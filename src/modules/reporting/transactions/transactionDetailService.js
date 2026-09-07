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

/** Fetches the staff-uploaded invoice photo/PDF for a GRV, base64-encoded (see
 * getGrvInvoiceFile in the Worker) — only called once the user clicks "Preview Invoice", never
 * eagerly, since it can be up to ~2MB of JSON for a photo. */
export async function fetchGrvInvoiceFile(workspaceId, grvId) {
  const response = await callCloudflareWorkspaceRoute(workspaceId, "grv/invoice-file", {
    query: { grvId },
  });
  if (!response?.dataBase64) throw new Error("Invoice file was not returned.");
  return { mimeType: response.mimeType || "application/octet-stream", dataBase64: response.dataBase64 };
}
