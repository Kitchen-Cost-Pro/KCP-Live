import { Env } from './types';
import { AuthContext } from './types';
import { error, json } from './http';

const text = (v: unknown): string => String(v ?? '').trim();

const GEMINI_API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
// gemini-2.5-flash was retired for new API users (Google now returns a 404 directing callers to
// this model) — override via the GEMINI_MODEL secret/var if that changes again.
const DEFAULT_GEMINI_MODEL = 'gemini-3.6-flash';

// Field lists mirror the app's own bulk-import template column headers exactly
// (src/services/exportService.js exportSchemas) — the onboarding wizard's existing
// CSV-import pipeline (mapSupplierImportRows / mapLegacyStockRows / mapLegacyRecipeRows in
// src/main.js) already does case/spacing-tolerant matching against these same header names, so
// rows shaped this way need no new parsing on the frontend at all.
const ROW_SCHEMAS: Record<string, { properties: Record<string, { type: string }>; required: string[] }> = {
  suppliers: {
    properties: {
      Supplier_Name: { type: 'STRING' },
      Contact_Person: { type: 'STRING' },
      Email: { type: 'STRING' },
      Phone: { type: 'STRING' },
      Category: { type: 'STRING' },
      Address_Line_1: { type: 'STRING' },
      City: { type: 'STRING' },
      Notes: { type: 'STRING' }
    },
    required: ['Supplier_Name']
  },
  stock: {
    properties: {
      Item_Name: { type: 'STRING' },
      SKU: { type: 'STRING' },
      Category: { type: 'STRING' },
      Base_UOM: { type: 'STRING' },
      UOM_1_Name: { type: 'STRING' },
      UOM_1_Qty_In_Base: { type: 'STRING' },
      UOM_2_Name: { type: 'STRING' },
      UOM_2_Qty_In_Base: { type: 'STRING' },
      VAT_Enabled: { type: 'STRING' },
      Cost_Ex_VAT: { type: 'STRING' },
      Opening_Stock: { type: 'STRING' },
      Notes: { type: 'STRING' }
    },
    required: ['Item_Name']
  },
  recipes: {
    properties: {
      Product_Name: { type: 'STRING' },
      Ingredient_Name: { type: 'STRING' },
      Quantity_Needed: { type: 'STRING' },
      UOM: { type: 'STRING' }
    },
    required: ['Product_Name', 'Ingredient_Name', 'Quantity_Needed']
  }
};

// Multi-entity handwritten/cluttered pages are a known weak spot for vision models — they tend
// to lock onto the single most visually prominent block (the first entry, the one in a box, the
// one at the top) and undercount everything else scattered around it. These prompts are written
// defensively against exactly that failure mode: explicit scan order, an explicit "don't stop
// early" instruction, and a description of what an entity boundary looks like on a messy page.
function buildPrompt(kind: string, knownProductNames: string[]): string {
  if (kind === 'suppliers') {
    return `This image is a page of handwritten or printed supplier notes. It very likely contains MULTIPLE separate suppliers scattered anywhere across the page — not just one. Suppliers may be boxed, circled, separated by blank space, in different colors of ink, or just written one after another with no clear divider.

Scan the ENTIRE image systematically, left to right and top to bottom, treating every block that has its own name/contact-person/phone/email as a SEPARATE supplier row, even if it's a small entry in a corner or squeezed between other notes. Do not stop after the first or most prominent one — count how many distinct supplier names appear before answering, and make sure your output has that many rows.

A new supplier typically starts with a business or person's name, usually followed by a phone number and/or email on the next lines. Pricing notes, delivery-day reminders, payment terms, "call about X", or general reminders (e.g. "pay Friday", "send proof of payment") are NOT suppliers themselves — they belong to whichever supplier block they're physically nearest to, and should be folded into that supplier's Notes field, not treated as their own row.

Leave a field blank rather than guessing if it is not legible or not present. Extract every distinct supplier as one row each.`;
  }
  if (kind === 'stock') {
    return `This image is a page of handwritten or printed stock/ingredient notes, typically written as "Item name — pack description" (e.g. "Cake flour — 12.5 kg bag" or "Burger buns — 8s bag / case 12 bags"). It may contain MULTIPLE separate items scattered across the page, not just one or two. Scan the ENTIRE image systematically, left to right and top to bottom — do not stop after the first item or the most prominent block. Count how many distinct items appear before answering, and make sure your output has that many rows.

For EACH item, separate the pack description into structured fields — never leave the raw pack text sitting in one field:

- Base_UOM: the smallest real measurement unit the item is costed/used in — always one of kg, g, L, ml, or each. Infer this confidently from context even if the page never states it explicitly (flour/mince/cheese/butter/pepper are weighed → kg or g; oil/milk/sauce/syrup are liquid → L or ml; eggs/buns/lemons/avocados/tea bags are counted individually → each). NEVER leave Base_UOM blank, and NEVER put a package word (bag, case, tray, box, sleeve, carton, punnet, BIB, pack, dozen) in Base_UOM — those are pack names, not units.
- UOM_1_Name / UOM_1_Qty_In_Base: the FIRST purchase pack tier — the smallest named package the item is bought in (e.g. "Bag", "Tray", "Bottle", "Vac Pack", "Punnet") — and exactly how many Base_UOM units are in ONE of that pack, as a plain number (e.g. a "12.5 kg bag" → UOM_1_Name "Bag", UOM_1_Qty_In_Base "12.5"; a "tray x 30" of eggs with Base_UOM each → UOM_1_Name "Tray", UOM_1_Qty_In_Base "30").
- UOM_2_Name / UOM_2_Qty_In_Base: ONLY fill this in if the page describes a SECOND, larger tier that nests the first (e.g. "case of 12 bags" where each bag is already UOM_1). UOM_2_Qty_In_Base is how many Base_UOM units are in ONE of the UOM_2 pack, not how many UOM_1 packs — multiply through (e.g. a case of 12 bags of 8 buns each = 96 each for the case).
- Only fill in a UOM_1 or UOM_2 name/qty pair when you are CONFIDENT of BOTH the pack name AND a precise numeric quantity. If the quantity is vague, approximate, marked with a question mark, or a conversion you're not sure of, leave that pack tier's Name and Qty_In_Base BOTH blank rather than guessing — a half-filled pack tier gets the whole item rejected on import. Describe the uncertain pack in Notes instead, and flag it (see below).
- Category: a short, sensible stock category guess based on what kind of ingredient it is (e.g. "Dairy", "Meat", "Produce", "Dry Goods", "Beverages", "Packaging", "Cleaning Supplies", "Bakery"). NEVER leave this blank and never use a generic placeholder like "General" or "Raw Materials".
- VAT_Enabled: "Yes" or "No" — never leave this blank. This is a South African business, where a specific list of basic foodstuffs is zero-rated (VAT_Enabled "No") and everything else is standard-rated at 15% (VAT_Enabled "Yes"). Use "No" ONLY for items on South Africa's zero-rated basic foodstuffs list: unprocessed/fresh fruit and vegetables, dried beans/lentils/samp/mealie rice, brown bread, plain rice, milk (including powdered/cultured), eggs, edible/cooking oil (not olive oil — that's standard-rated), and illuminating paraffin. Use "Yes" for everything else, including meat, cheese, packaged/processed foods, baked goods other than plain brown bread, beverages, cleaning supplies, and packaging — these are standard-rated even though they're still "food".
- Notes: always copy the original raw pack description text here verbatim first (e.g. "8s bag / case 12 bags"). Only prepend "⚠️ REVIEW: " and a short reason when one of the specific cases below applies — most items should NOT be flagged.

Prepend "⚠️ REVIEW: " ONLY when the PURCHASE-PACK CONVERSION NUMBER ITSELF is genuinely unreliable, not just because the page has some unrelated handwritten comment near the item. Concretely, that means only these cases:
- the pack quantity is explicitly approximate (e.g. "about 40 scoops", "approximately 20 bulbs") — a plain number with no such qualifier is NOT approximate, extract it normally
- it's a catch-weight item — sold or priced per each but only an average/typical weight is given (e.g. "each / avg wt 1.35 kg"), so the each→weight conversion is inherently variable
- two DIFFERENT measurement dimensions are given for the same pack that don't convert into each other (e.g. a container's fluid volume like "400 ml" alongside a separately-stated net product weight like "300 g"; or a roll given as width AND length like "450mm x 600m" with no single pack quantity)
- the number given is a returnable-container deposit or a recipe/dilution yield ratio (e.g. "yield note 1:5"), not a purchase-pack size at all

Do NOT flag for review just because the page has a general margin note, question mark, "check!", abbreviation, or reminder that doesn't change how confident you are in the Base_UOM/pack numbers you extracted — fold that text into Notes plainly (no ⚠️) if useful context, or drop it if not. A crossed-out value you've already resolved by using the correction is also not review-worthy — just extract the corrected number.

Cost_Ex_VAT and Opening_Stock should be plain numbers as text (no currency symbols) — leave blank if not present. Leave any field blank rather than guessing if it is not legible or not present at all. Extract every distinct stock item as one row each.`;
  }
  const knownList = knownProductNames.length
    ? `\n\nThese are the exact product names already in the system that still need a recipe — Product_Name must be an EXACT copy of one of these when the card corresponds to one of them, do not invent a new product name and do not alter spelling/casing/spacing:\n${knownProductNames.map((n) => `- ${n}`).join('\n')}\n\nIf the card's actual dish/product does not clearly correspond to any name in that list, OMIT that recipe from your output entirely rather than guessing or using a placeholder — a wrong or unmatched Product_Name cannot be imported.`
    : '';
  return `This image shows a recipe card: a product and its list of ingredients with quantities. Extract one row per ingredient line (so a single recipe with 5 ingredients produces 5 rows, all sharing the same Product_Name). Quantity_Needed should be a plain number as text. UOM is the unit (e.g. g, kg, ml, ea, Box).

Product_Name must be the actual name of the specific dish/menu item this card is for — NEVER a generic section heading or label that happens to be printed on the page, such as "Ingredients", "Ingredients List", "Recipe", "Method", "Directions", or "Instructions". If you cannot find the actual dish name anywhere on the card, omit that recipe from your output rather than using a generic label as Product_Name.${knownList}`;
}

// Second-pass prompt for the confidence-weighted re-ask: hands the model its own first-pass
// answer and asks it to specifically hunt for what it missed, rather than re-extracting from
// scratch (which would just re-run the same undercounting risk). Kept short and scoped so this
// pass is fast — it should usually come back with an empty array.
function buildReaskPrompt(kind: string, foundNames: string[]): string {
  const noun = kind === 'suppliers' ? 'suppliers' : 'stock/ingredient items';
  const list = foundNames.length ? foundNames.map((n) => `- ${n}`).join('\n') : '(none found)';
  return `You already scanned this image once and found these ${noun}:\n${list}\n\nLook at the image AGAIN, very carefully, specifically hunting for any additional ${noun} that are NOT already in that list — ones tucked into a corner, squeezed into a margin, written in different ink, added as an afterthought, or otherwise easy to overlook on a first pass. Use the exact same field format as before for anything you find.

Only return items you're genuinely confident are present on the page and missing from the list above — do not return anything already in that list, and do not invent items. If you're confident the list above is already complete, return an empty array [].`;
}

class GeminiBusyError extends Error {}

async function callGeminiExtract(
  env: Env,
  mimeType: string,
  imageBase64: string,
  promptText: string,
  schema: { properties: Record<string, { type: string }>; required: string[] },
  maxOutputTokens: number
): Promise<unknown[]> {
  const model = env.GEMINI_MODEL || DEFAULT_GEMINI_MODEL;
  const geminiResponse = await fetch(`${GEMINI_API_BASE}/${model}:generateContent`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': String(env.GEMINI_API_KEY),
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      contents: [{
        parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: promptText }
        ]
      }],
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'ARRAY',
          items: { type: 'OBJECT', properties: schema.properties, required: schema.required }
        },
        // temperature: 0 favors thorough, literal extraction over "creative" summarizing — the
        // latter is exactly what causes a busy multi-supplier page to collapse into one row.
        temperature: 0,
        maxOutputTokens
      }
    })
  });

  if (!geminiResponse.ok) {
    const errBody = await geminiResponse.text().catch(() => '');
    // 429 (rate limit) and 503 (model overloaded) are Gemini free-tier capacity errors, not real
    // failures — the "AI_BUSY:" marker lets the frontend recognize these and retry automatically
    // with a "queued" message instead of surfacing a raw error to the user.
    if (geminiResponse.status === 429 || geminiResponse.status === 503) {
      throw new GeminiBusyError(`AI_BUSY: The AI is at capacity right now. ${errBody.slice(0, 150)}`);
    }
    throw new Error(`AI extraction error: ${geminiResponse.status}. ${errBody.slice(0, 200)}`);
  }

  const geminiData = await geminiResponse.json() as Record<string, unknown>;
  const candidate = (geminiData.candidates as Array<Record<string, unknown>>)?.[0];
  const part = ((candidate?.content as Record<string, unknown>)?.parts as Array<Record<string, unknown>>)?.[0];
  const rawText = text(part?.text || '[]');

  try {
    const parsed = JSON.parse(rawText);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    if (candidate?.finishReason === 'MAX_TOKENS') {
      throw new Error('That photo has too much on it to scan in one go. Try splitting it into a few photos, each covering fewer entries.');
    }
    throw new Error('AI extraction returned an unreadable response. Please try a clearer photo.');
  }
}

export async function postWorkspaceAiExtract(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string
): Promise<Response> {
  if (!env.GEMINI_API_KEY) {
    return error(request, env, 503, 'AI onboarding is not configured. Please add a GEMINI_API_KEY to the worker secrets.');
  }

  const settingsRow = await env.DB.prepare(
    `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`
  ).bind(workspaceId).first<{ raw_json: string }>();
  const wsSettings = (() => { try { return JSON.parse(settingsRow?.raw_json || '{}'); } catch { return {}; } })();
  if (wsSettings.ai_onboarding_enabled !== true) {
    return error(request, env, 503, 'AI onboarding is disabled for this workspace.');
  }

  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const kind = text(payload.kind || '');
  const schema = ROW_SCHEMAS[kind];
  if (!schema) return error(request, env, 400, 'kind must be one of: suppliers, stock, recipes.');

  const mimeType = text(payload.mimeType || 'image/jpeg');
  const imageBase64 = text(payload.imageBase64 || '');
  if (!imageBase64) return error(request, env, 400, 'imageBase64 is required.');

  const knownProductNames = Array.isArray(payload.knownProductNames)
    ? (payload.knownProductNames as unknown[]).map((v) => text(v)).filter(Boolean).slice(0, 300)
    : [];

  // maxOutputTokens is generous so a page with many entities can't get cut off mid-array — the
  // stock schema in particular carries 4 extra pack-tier fields plus review Notes per row, which
  // pushed a ~29-item page past the old 8192 cap.
  const FIRST_PASS_MAX_TOKENS = 32768;
  const REASK_MAX_TOKENS = 8192;
  const nameKey = kind === 'suppliers' ? 'Supplier_Name' : kind === 'stock' ? 'Item_Name' : '';

  try {
    let rows = await callGeminiExtract(env, mimeType, imageBase64, buildPrompt(kind, knownProductNames), schema, FIRST_PASS_MAX_TOKENS);

    // Confidence-weighted re-ask: multi-entity pages (suppliers/stock) are the ones known to get
    // undercounted on a single pass (see buildPrompt's comment above). A second, cheaper pass that
    // shows the model its own first-pass names and asks specifically what it missed catches most
    // of that without doubling the risk of a fresh pass hallucinating or reordering everything.
    // Recipe cards are normally a single product, so this doesn't apply there.
    if (nameKey && rows.length) {
      const foundNames = rows.map((r) => text((r as Record<string, unknown>)[nameKey])).filter(Boolean);
      const extraRows = await callGeminiExtract(env, mimeType, imageBase64, buildReaskPrompt(kind, foundNames), schema, REASK_MAX_TOKENS);
      const seen = new Set(foundNames.map((n) => n.toLowerCase()));
      const newRows = extraRows.filter((r) => {
        const name = text((r as Record<string, unknown>)[nameKey]).toLowerCase();
        if (!name || seen.has(name)) return false;
        seen.add(name);
        return true;
      });
      rows = [...rows, ...newRows];
    }

    return json(request, env, { ok: true, rows });
  } catch (err) {
    if (err instanceof GeminiBusyError) return error(request, env, 503, err.message);
    return error(request, env, 502, err instanceof Error ? err.message : 'AI extraction failed.');
  }
}
