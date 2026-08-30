import { callCloudflareWorkspaceRoute } from './cloudflareApi.js';

// Vision extraction takes longer than a typical API call, and suppliers/stock scans now run TWO
// sequential Gemini calls (first pass + a confidence-weighted re-ask for anything missed) on top
// of the pack-tier/category/VAT reasoning the stock prompt already does — 120s was cutting off
// mid-generation on busier photos.
const EXTRACT_TIMEOUT_MS = 175000;

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      const dataUrl = String(reader.result || '');
      const commaIndex = dataUrl.indexOf(',');
      resolve(commaIndex === -1 ? '' : dataUrl.slice(commaIndex + 1));
    });
    reader.addEventListener('error', () => reject(new Error('Could not read the selected photo.')));
    reader.readAsDataURL(file);
  });
}

// Hands a photo to the AI-onboarding Worker route (postWorkspaceAiExtract), which returns rows
// already shaped like the app's own bulk-import template columns (Supplier_Name, Item_Name,
// Product_Name/Ingredient_Name/Quantity_Needed/UOM, ...) — same shape a parsed CSV/XLSX row
// already has, so the caller can run these straight through the existing import mapper
// functions with no new parsing.
export async function extractDataWithAi(workspaceId, kind, file, { knownProductNames = [] } = {}) {
  if (!file) throw new Error('Choose a photo first.');
  const imageBase64 = await readFileAsBase64(file);
  if (!imageBase64) throw new Error('Could not read the selected photo.');

  const result = await callCloudflareWorkspaceRoute(workspaceId, 'ai-extract', {
    method: 'POST',
    timeoutMs: EXTRACT_TIMEOUT_MS,
    payload: {
      kind,
      mimeType: file.type || 'image/jpeg',
      imageBase64,
      knownProductNames
    }
  });

  return { rows: Array.isArray(result?.rows) ? result.rows : [] };
}
