import { Env } from './types';
import { AuthContext } from './types';
import { error, json } from './http';
import { checkRateLimit } from './rate-limit';
const text = (v: unknown): string => String(v ?? '').trim();
const numberValue = (v: unknown, fallback: number): number => { const n = Number(v); return Number.isFinite(n) ? n : fallback; };

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';

const SYSTEM_PROMPT = `You are KCP Assistant — an AI helper built into Kitchen Cost Pro (KCP), a restaurant inventory and recipe costing platform integrated with Yoco POS.

## Data sources — use the correct tool for each question type:

**KCP data (stock, recipes, menu)** — use these tools for anything about ingredients, stock levels, recipes, GP%, or the menu catalogue:
- get_low_stock_items → stock running low, needs reordering
- get_stock_levels → current quantities for any ingredient
- get_recipe_cost → ingredient breakdown and GP% for a menu item
- get_worst_gp_items → lowest GP% products (recipe cost vs selling price)
- get_menu_catalogue → list of menu products and prices
- get_items_without_recipes → menu items that have no recipe linked
- get_days_remaining → how many days of stock are left for an ingredient based on usage
- get_grv_anomalies → flag GRV entries where cost is suspiciously high or low vs history

**Canonical Yoco V2 reporting data (sales, orders, revenue)** — use this tool for anything about sales performance, revenue, orders, or turnover:
- get_monthly_sales → actual completed orders from Yoco POS for a given month
- get_refunds → refunds/reversals from Yoco for a given month

## General assistant knowledge (answer these WITHOUT calling a tool):
You know KCP (Kitchen Cost Pro) deeply and can answer how-to and concept questions for every section.

### Dashboard
The Dashboard gives a live overview of your workspace: low stock alerts, recent GP performance, sales summary, and stock value. Tiles refresh automatically. Click any tile to drill into the relevant section.

### Menu Catalogue (Products)
- **What it is**: Your full Yoco POS menu — every item you sell, synced from Yoco.
- **Add a product**: Products sync automatically from Yoco. To manually add, go to Menu Catalogue → "+ Add Product" → fill in name, category, selling price, and optional SKU/barcode.
- **Edit a product**: Click the product row → edit name, price, category, or modifiers.
- **Modifiers**: Product- and option-level modifier choices are synced from the complete Yoco modifier-group catalogue. Free-text note fields are observed separately, and only customer-approved exact note rules can affect stock.
- **GP%**: Gross Profit % shows automatically once a recipe is linked. GP% = (Selling Price − Recipe Cost) ÷ Selling Price × 100.

### Recipes
- **What it is**: Link menu products to their ingredient costs so KCP can calculate theoretical GP.
- **Create a recipe**: Go to Recipes → find the product → click "+ Build Recipe" → search for stock items → enter quantity used per portion → Save. GP% updates instantly.
- **Recipe cost**: Sum of (ingredient quantity × unit cost) for all lines.
- **Yield %**: If an ingredient loses weight during prep (e.g. meat trim), set a yield % to account for the waste. KCP adjusts the effective cost automatically.
- **Batch yield**: For manufactured items (e.g. a sauce that makes 10L), set batch yield so the per-portion cost is correct.
- **Why GP is wrong**: Common causes — unit cost outdated (update via GRV), yield not set, recipe quantity is per batch not per portion.

### Stock Items (Ingredients)
- **What it is**: Your ingredient master list with costs, units, categories, and location balances.
- **Add a stock item**: Inventory → Stock Items → "+ Add Ingredient" → name, category, unit (e.g. kg, l, ea), unit cost → Save. Optionally set threshold (low stock alert) and par level (reorder target).
- **Unit cost**: The cost per base unit (e.g. R15/kg). Update this when prices change to keep GP accurate.
- **Threshold vs par level**: Threshold = alert me when stock drops below this. Par level = order up to this quantity.
- **Location balances**: Each item shows total stock across all locations. Expand to see per-location breakdown.
- **Barcode**: Add a barcode/PLU to enable barcode scanning during stock takes.
- **VAT**: Toggle VAT-enabled if the ingredient is purchased with VAT — KCP handles the ex-VAT cost calculation.
- **Item types**: Standard (counted in stock), Non-stocked (tracked for cost only, not counted).

### Suppliers
- **What it is**: Your supplier directory linked to purchase orders and GRVs.
- **Add a supplier**: Suppliers → "+ Add Supplier" → name, contact details, optional account number.
- **Link to stock items**: Suppliers are selected when creating purchase orders and GRVs. KCP tracks which supplier provides each item via order history.

### Purchase Orders (POs)
- **What it is**: Create and send orders to suppliers before goods arrive.
- **Create a PO**: Purchase Orders → "+ New Order" → select supplier → add items with quantities → set expected delivery date → Save or Send.
- **Convert to GRV**: When goods arrive, open the PO → "Receive" → it pre-fills a GRV with the ordered quantities. You adjust actuals before committing.
- **Location**: Specify which location (store room, kitchen etc.) the stock should be received into.
- **Statuses**: Draft → Sent → Partially Received → Received → Closed.

### GRV Entry (Goods Received Voucher)
- **What it is**: Record stock actually received. This is the most important step for keeping stock levels and costs accurate.
- **Create a GRV**: GRV Entry → "+ New GRV" → select supplier → add each item received with quantity and unit cost → Commit.
- **From a PO**: Open a PO → click Receive → GRV pre-fills with ordered lines. Adjust quantities and costs to match the actual delivery.
- **Pack size**: If you buy in cases (e.g. 12 × 750ml), set pack size = 12 so KCP converts to your base unit automatically.
- **Unit cost vs pack price**: Enter the cost per base unit OR the pack price — KCP calculates the other automatically.
- **VAT**: If the supplier invoice includes VAT, toggle VAT on — KCP extracts the ex-VAT cost for recipe costing.
- **Committing a GRV**: Once committed, stock levels update immediately and the unit cost on all linked stock items updates to the latest received cost.
- **Anomaly tip**: If GP suddenly drops on an item, check GRV history — a data entry error (e.g. bottle price entered per tot) will show as an unusually high unit cost vs the average. Use "Check GRVs for anomalies" in this assistant.

### Credit Notes
- **What it is**: Record stock returned to a supplier (damaged goods, over-delivery, etc.).
- **Create a credit note**: Credit Notes → "+ New Credit Note" → select supplier → add returned items with quantities and costs → Commit. Stock levels decrease and costs are reversed.

### Adjustments
- **What it is**: Manually increase or decrease stock for reasons not covered by GRV or transfers — waste, spoilage, breakage, complimentary items, recipe testing.
- **Create an adjustment**: Adjustments → "+ New Adjustment" → select stock item → choose location → enter quantity (positive = add, negative = remove) → reason → Save.
- **Best practice**: Always add a reason (e.g. "Wastage — expired milk") so dashboard views are meaningful.

### Transfers
- **What it is**: Move stock from one location to another (e.g. Main Store → Kitchen, Bar top-up).
- **Create a transfer**: Transfers → "+ New Transfer" → select From location and To location → add items and quantities → Commit. Stock decreases at source and increases at destination.
- **Templates**: Save frequently used transfers as templates (e.g. daily bar setup) to speed up data entry.

### Stock Take
- **What it is**: Count physical stock and compare against KCP's expected theoretical stock. The variance reveals shrinkage, waste, or theft.
- **Start a stock take**: Stock Take → "+ New Session" → select locations → start counting. Use barcode scanner or type item names.
- **Count methods**: By item (all locations for one item) or by location (all items in one location).
- **Submit**: Once all items are counted, submit the session. KCP shows variance (expected vs actual) and adjusts stock levels to the counted quantities.
- **Templates**: Create count templates for specific areas (e.g. "Bar weekly count") to save setup time.
- **Frequency tip**: Weekly stock takes on high-value/high-theft items, monthly for bulk dry goods.

### Locations
- **What it is**: Define physical storage areas — Main Store, Kitchen, Bar, Walk-in Fridge, etc.
- **Add a location**: Locations → "+ Add Location" → name, type (storage or selling), set as default if needed.
- **Default location**: The default location receives stock when no location is specified on a GRV.
- **Selling locations**: Linked to Yoco tills. Sales deduct from the selling location's stock.

### Manufacturing
- **What it is**: Track in-house production — making a sauce, butchering a whole animal, batch cooking. Converts raw ingredients into finished manufactured products.
- **Blueprint**: Define the recipe for a manufactured product — what raw ingredients go in, what yield comes out.
- **Batch**: Run a batch to deduct raw ingredients from stock and add the manufactured output.
- **Use case**: A restaurant that makes its own stocks, spice blends, or portioned proteins uses Manufacturing to track true input costs.

### Dashboard & Insights
- **Stock Movement View**: Shows stock movement activity from GRVs, adjustments, transfers, and sales deductions.
- **GP View**: Shows theoretical GP% per product based on recipe cost vs selling price.
- **Sales View**: Shows revenue and quantity sold per product synced from Yoco.
- **Low Stock View**: Shows items currently below threshold.
- **Location filter**: Most dashboard views can be filtered by location for a specific store or area view.

### Integrations
- **Yoco**: Connect your Yoco account via API key (Integrations → Yoco). Once connected, the menu catalogue syncs automatically and sales data flows in via webhooks in real time.
- **Sync catalogue**: If menu items are missing after connecting, trigger a manual catalogue sync from Integrations → Yoco → Sync Catalogue.
- **Webhooks**: KCP registers a Yoco webhook automatically on connect. Sales update stock levels and dashboard summaries without any manual action.

### Settings
- **Business info**: Update your workspace name, address, and VAT number.
- **Users & Roles**: Invite team members (Settings → Users), assign roles (Owner, Manager, Staff). Custom roles let you control which sections each user can access.
- **Low stock emails**: Configure email alerts for when items drop below threshold (Settings → Notifications).

### General tips
- **GP is wrong?** Check: (1) recipe is linked, (2) recipe quantities are per portion not per batch, (3) unit cost is up to date (last GRV price), (4) yield % is set correctly.
- **Stock levels wrong?** Check: (1) GRVs are committed not drafted, (2) stock take has been submitted, (3) correct location is selected.
- **Yoco products not showing?** Trigger a manual catalogue sync from Integrations → Yoco.
- **New team member can't see a section?** Check their role permissions in Settings → Roles.

## Rules:
- ALWAYS call the correct tool. NEVER guess, invent, or assume any numbers.
- NEVER explain which tool you are going to use. Just call it silently and return the results directly.
- NEVER say "I would use the X tool" or "The X tool returns...". Just show the data.
- Only return what the tool returns. If it returns empty, say so in one sentence.
- For sales/revenue questions → use get_monthly_sales (Yoco). Do NOT use KCP stock tools for sales.
- For stock/inventory/recipe questions → use KCP tools. Do NOT use Yoco tools for stock.
- Currency is South African Rand (R). GP% = (Selling Price − Ingredient Cost) ÷ Selling Price × 100.
- When showing lists — use a markdown table with clear column headers.
- Always include the R currency symbol for prices and costs.
- Be concise. Operators are busy. No preamble, no sign-off.`;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_low_stock_items',
      description: 'Get all stock items currently below their low-stock threshold. Use this when someone asks what needs to be reordered, what is running low, or what is below threshold/par.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_stock_levels',
      description: 'Get current stock levels for all items or search by name. Use this for general stock queries.',
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Optional: filter by item name (partial match)'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_recipe_cost',
      description: 'Get the ingredient cost, selling price, and GP% for a menu product by name. Use this for cost or GP queries about specific dishes.',
      parameters: {
        type: 'object',
        required: ['product_name'],
        properties: {
          product_name: {
            type: 'string',
            description: 'Name or partial name of the menu product'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_top_selling_items',
      description: 'Get the top 10 best selling menu items ranked by quantity sold.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_menu_catalogue',
      description: 'List or search menu products and their prices.',
      parameters: {
        type: 'object',
        properties: {
          search: {
            type: 'string',
            description: 'Optional: filter by product name or category'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_worst_gp_items',
      description: 'Get the 10 menu products with the lowest GP%, useful for identifying underperforming items.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_days_remaining',
      description: 'Calculate how many days of stock remain for a specific ingredient, based on current stock level and average daily usage from recent Yoco sales. Use this for "how long will X last", "days of stock left", "will we run out of X".',
      parameters: {
        type: 'object',
        properties: {
          item_name: {
            type: 'string',
            description: 'Name or partial name of the stock item to check'
          }
        },
        required: ['item_name']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_grv_anomalies',
      description: 'Detect anomalies in recent GRV (goods received voucher) entries — items where the unit cost is significantly higher or lower than the historical average. Useful for catching data entry errors like bottle price entered instead of tot price.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_items_without_recipes',
      description: 'List menu products that have no recipe linked in KCP. Use this when someone asks how many items lack recipes, or which items have no costing set up.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_refunds',
      description: 'Get refunds recorded by the KCP canonical Yoco V2 reporting engine for a given month. Use this for any question about refunds, returns, or reversals.',
      parameters: {
        type: 'object',
        properties: {
          month: {
            type: 'string',
            description: 'Month in YYYY-MM format. Defaults to current month if omitted.'
          }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_monthly_sales',
      description: 'Get sales totals and order counts recorded by the KCP canonical Yoco V2 reporting engine for the current or a recent month. Use this for any question about revenue, sales totals, orders, or turnover.',
      parameters: {
        type: 'object',
        properties: {
          month: {
            type: 'string',
            description: 'Month in YYYY-MM format, e.g. "2026-06". Defaults to current month if omitted.'
          }
        }
      }
    }
  }
];

async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  workspaceId: string,
  env: Env
): Promise<string> {
  try {
    switch (toolName) {
      case 'get_low_stock_items': {
        const rows = await env.DB.prepare(`
          SELECT si.name, si.unit,
                 ROUND(COALESCE(SUM(sb.quantity), 0), 2) AS qty,
                 ROUND(si.threshold_qty, 2) AS threshold,
                 ROUND(si.unit_cost, 2) AS unit_cost
          FROM stock_items si
          LEFT JOIN stock_balances sb ON sb.stock_item_id = si.id AND sb.workspace_id = ?1
          WHERE si.workspace_id = ?1 AND si.active = 1
          GROUP BY si.id
          HAVING qty < si.threshold_qty
          ORDER BY qty ASC
          LIMIT 30
        `).bind(workspaceId).all();
        if (!rows.results.length) return 'No items are currently below their low-stock threshold. All good!';
        return JSON.stringify(rows.results);
      }

      case 'get_stock_levels': {
        const search = text(args.search || '');
        let rows;
        if (search) {
          rows = await env.DB.prepare(`
            SELECT si.name, si.unit,
                   ROUND(COALESCE(SUM(sb.quantity), 0), 2) AS qty,
                   ROUND(si.unit_cost, 2) AS unit_cost,
                   CASE WHEN COALESCE(SUM(sb.quantity), 0) < si.threshold_qty THEN 'LOW' ELSE 'OK' END AS status
            FROM stock_items si
            LEFT JOIN stock_balances sb ON sb.stock_item_id = si.id AND sb.workspace_id = ?1
            WHERE si.workspace_id = ?1 AND si.active = 1 AND lower(si.name) LIKE lower(?2)
            GROUP BY si.id
            ORDER BY si.name ASC
            LIMIT 50
          `).bind(workspaceId, `%${search}%`).all();
        } else {
          rows = await env.DB.prepare(`
            SELECT si.name, si.unit,
                   ROUND(COALESCE(SUM(sb.quantity), 0), 2) AS qty,
                   ROUND(si.unit_cost, 2) AS unit_cost,
                   CASE WHEN COALESCE(SUM(sb.quantity), 0) < si.threshold_qty THEN 'LOW' ELSE 'OK' END AS status
            FROM stock_items si
            LEFT JOIN stock_balances sb ON sb.stock_item_id = si.id AND sb.workspace_id = ?1
            WHERE si.workspace_id = ?1 AND si.active = 1
            GROUP BY si.id
            ORDER BY si.name ASC
            LIMIT 50
          `).bind(workspaceId).all();
        }
        if (!rows.results.length) return 'No stock items found.';
        return JSON.stringify(rows.results);
      }

      case 'get_recipe_cost': {
        const productName = text(args.product_name || '');
        if (!productName) return 'Please provide a product name to look up.';
        const rows = await env.DB.prepare(`
          SELECT p.name,
                 ROUND(p.price, 2) AS selling_price,
                 ROUND(SUM(rl.quantity * si.unit_cost), 2) AS ingredient_cost,
                 CASE WHEN p.price > 0
                      THEN ROUND((1.0 - SUM(rl.quantity * si.unit_cost) / p.price) * 100, 1)
                      ELSE NULL END AS gp_percent,
                 GROUP_CONCAT(si.name || ' x' || ROUND(rl.quantity,3) || ' ' || si.unit || ' @ R' || ROUND(si.unit_cost,2), ' | ') AS ingredients
          FROM products p
          JOIN recipes r ON r.owner_id = p.id AND r.owner_type = 'product' AND r.workspace_id = ?1
          JOIN recipe_lines rl ON rl.recipe_id = r.id
          JOIN stock_items si ON si.id = rl.stock_item_id AND si.workspace_id = ?1
          WHERE p.workspace_id = ?1 AND lower(p.name) LIKE lower(?2) AND p.active = 1
          GROUP BY p.id
          ORDER BY p.name ASC
          LIMIT 10
        `).bind(workspaceId, `%${productName}%`).all();
        if (!rows.results.length) return `No products found matching "${productName}" with a recipe. Make sure the product has a recipe linked in KCP.`;
        return JSON.stringify(rows.results);
      }

      case 'get_top_selling_items': {
        const limit = Math.min(numberValue(args.limit, 10), 20);
        const rows = await env.DB.prepare(`
          SELECT p.name, p.category,
                 ROUND(p.price, 2) AS price,
                 COALESCE(SUM(yol.quantity), 0) AS total_sold,
                 ROUND(COALESCE(SUM(yol.total), 0) / 100.0, 2) AS total_revenue
          FROM products p
          JOIN yoco_order_lines yol ON yol.product_id = p.id
          WHERE p.workspace_id = ?1 AND p.active = 1
          GROUP BY p.id
          ORDER BY total_sold DESC
          LIMIT ?2
        `).bind(workspaceId, limit).all();
        if (!rows.results.length) return 'No sales data found yet. Sales data comes in via Yoco webhooks.';
        return JSON.stringify(rows.results);
      }

      case 'get_menu_catalogue': {
        const search = text(args.search || '');
        let rows;
        if (search) {
          rows = await env.DB.prepare(`
            SELECT p.name, p.category, ROUND(p.price, 2) AS price
            FROM products p
            WHERE p.workspace_id = ?1 AND p.active = 1
              AND (lower(p.name) LIKE lower(?2) OR lower(p.category) LIKE lower(?2))
            ORDER BY p.category, p.name ASC
            LIMIT 50
          `).bind(workspaceId, `%${search}%`).all();
        } else {
          rows = await env.DB.prepare(`
            SELECT p.name, p.category, ROUND(p.price, 2) AS price
            FROM products p
            WHERE p.workspace_id = ?1 AND p.active = 1
            ORDER BY p.category, p.name ASC
            LIMIT 50
          `).bind(workspaceId).all();
        }
        if (!rows.results.length) return 'No products found in the menu catalogue.';
        return JSON.stringify(rows.results);
      }

      case 'get_worst_gp_items': {
        const limit = Math.min(numberValue(args.limit, 10), 20);
        // Debug: confirm workspace has products and recipes
        const debugCount = await env.DB.prepare(
          `SELECT COUNT(*) as cnt FROM products WHERE workspace_id = ?1 AND active = 1`
        ).bind(workspaceId).first() as Record<string, unknown> | null;
        const recipeCount = await env.DB.prepare(
          `SELECT COUNT(*) as cnt FROM recipes WHERE workspace_id = ?1 AND owner_type = 'product'`
        ).bind(workspaceId).first() as Record<string, unknown> | null;
        console.log(`[chat:gp] workspace="${workspaceId}" products=${debugCount?.cnt} recipes=${recipeCount?.cnt}`);
        const rows = await env.DB.prepare(`
          SELECT p.name, p.category,
                 ROUND(p.price, 2) AS selling_price,
                 ROUND(SUM(rl.quantity * si.unit_cost), 2) AS ingredient_cost,
                 ROUND((1.0 - SUM(rl.quantity * si.unit_cost) / p.price) * 100, 1) AS gp_percent
          FROM products p
          JOIN recipes r ON r.owner_id = p.id AND r.owner_type = 'product' AND r.workspace_id = ?1
          JOIN recipe_lines rl ON rl.recipe_id = r.id
          JOIN stock_items si ON si.id = rl.stock_item_id AND si.workspace_id = ?1
          WHERE p.workspace_id = ?1 AND p.active = 1 AND p.price > 0
          GROUP BY p.id
          HAVING ingredient_cost > 0
          ORDER BY gp_percent ASC
          LIMIT ?2
        `).bind(workspaceId, limit).all();
        console.log(`[chat:gp] result_rows=${rows.results.length}`);
        if (!rows.results.length) return JSON.stringify({ debug: { workspace: workspaceId, products: debugCount?.cnt, recipes: recipeCount?.cnt }, error: 'No products with recipes found' });
        // Always include workspace in result for debugging
        return JSON.stringify({ workspace: workspaceId, items: rows.results });
      }

      case 'get_days_remaining': {
        const itemName = text(args.item_name || '');
        if (!itemName) return 'Please provide a stock item name.';
        // Get current stock level
        const stockRow = await env.DB.prepare(`
          SELECT si.name, si.unit, si.unit_cost,
                 ROUND(COALESCE(SUM(sb.quantity), 0), 3) AS current_stock
          FROM stock_items si
          LEFT JOIN stock_balances sb ON sb.stock_item_id = si.id AND sb.workspace_id = ?1
          WHERE si.workspace_id = ?1 AND si.active = 1 AND lower(si.name) LIKE lower(?2)
          GROUP BY si.id
          ORDER BY si.name
          LIMIT 1
        `).bind(workspaceId, `%${itemName}%`).first() as Record<string, unknown> | null;
        if (!stockRow) return `No stock item found matching "${itemName}".`;

        // Get avg daily usage: sum of recipe_line qty * orders in last 30 days
        const usageRow = await env.DB.prepare(`
          SELECT ROUND(COALESCE(SUM(rl.quantity * COALESCE(yol.quantity, 0)), 0) / 30.0, 4) AS avg_daily_usage
          FROM recipe_lines rl
          JOIN recipes r ON r.id = rl.recipe_id AND r.workspace_id = ?1 AND r.owner_type = 'product'
          JOIN products p ON p.id = r.owner_id AND p.workspace_id = ?1 AND p.active = 1
          LEFT JOIN yoco_order_lines yol ON yol.product_id = p.id
            AND yol.created_at >= datetime('now', '-30 days')
          WHERE rl.stock_item_id = (
            SELECT id FROM stock_items WHERE workspace_id = ?1 AND lower(name) LIKE lower(?2) LIMIT 1
          )
        `).bind(workspaceId, `%${itemName}%`).first() as Record<string, unknown> | null;

        const currentStock = Number(stockRow.current_stock || 0);
        const avgDaily = Number(usageRow?.avg_daily_usage || 0);

        if (avgDaily <= 0) {
          return JSON.stringify({
            item: stockRow.name,
            unit: stockRow.unit,
            current_stock: `${currentStock} ${stockRow.unit}`,
            avg_daily_usage: 'No sales data available for usage calculation',
            days_remaining: 'Unknown — no recent sales data'
          });
        }

        const daysLeft = Math.floor(currentStock / avgDaily);
        const status = daysLeft <= 0 ? 'OUT OF STOCK' : daysLeft <= 3 ? 'CRITICAL' : daysLeft <= 7 ? 'LOW' : 'OK';
        return JSON.stringify({
          item: stockRow.name,
          unit: stockRow.unit,
          current_stock: `${currentStock} ${stockRow.unit}`,
          avg_daily_usage: `${avgDaily.toFixed(3)} ${stockRow.unit}/day`,
          days_remaining: daysLeft,
          status
        });
      }

      case 'get_grv_anomalies': {
        // Find GRV lines where cost deviates >50% from the historical avg cost for that item
        const rows = await env.DB.prepare(`
          WITH item_avg AS (
            SELECT gl.stock_item_id,
                   AVG(gl.unit_cost) AS avg_cost,
                   COUNT(*) AS grv_count
            FROM grv_lines gl
            JOIN grvs g ON g.id = gl.grv_id AND g.workspace_id = ?1
            WHERE gl.unit_cost > 0
            GROUP BY gl.stock_item_id
            HAVING grv_count >= 2
          )
          SELECT si.name AS item,
                 gl.unit_cost AS entered_cost,
                 ROUND(ia.avg_cost, 4) AS avg_cost,
                 ROUND(ABS(gl.unit_cost - ia.avg_cost) / ia.avg_cost * 100, 1) AS deviation_pct,
                 g.created_at AS grv_date,
                 g.supplier_id,
                 CASE WHEN gl.unit_cost > ia.avg_cost * 2 THEN 'PRICE_TOO_HIGH'
                      WHEN gl.unit_cost < ia.avg_cost * 0.4 THEN 'PRICE_TOO_LOW'
                      ELSE 'MINOR_VARIANCE' END AS anomaly_type
          FROM grv_lines gl
          JOIN grvs g ON g.id = gl.grv_id AND g.workspace_id = ?1
          JOIN stock_items si ON si.id = gl.stock_item_id AND si.workspace_id = ?1
          JOIN item_avg ia ON ia.stock_item_id = gl.stock_item_id
          WHERE gl.unit_cost > 0
            AND ABS(gl.unit_cost - ia.avg_cost) / ia.avg_cost > 0.5
            AND g.created_at >= datetime('now', '-90 days')
          ORDER BY deviation_pct DESC
          LIMIT 20
        `).bind(workspaceId).all();
        if (!rows.results.length) return 'No GRV anomalies detected in the last 90 days. All recent entries are within normal range.';
        return JSON.stringify(rows.results);
      }

      case 'get_items_without_recipes': {
        const rows = await env.DB.prepare(`
          SELECT p.name, p.category, ROUND(p.price, 2) AS selling_price
          FROM products p
          WHERE p.workspace_id = ?1 AND p.active = 1
            AND NOT EXISTS (
              SELECT 1 FROM recipes r
              WHERE r.owner_id = p.id AND r.owner_type = 'product' AND r.workspace_id = ?1
            )
          ORDER BY p.category, p.name
        `).bind(workspaceId).all();
        if (!rows.results.length) return 'All active menu items have recipes assigned.';
        return JSON.stringify({ count: rows.results.length, items: rows.results });
      }

      case 'get_refunds': {
        const monthArg = text(args.month || '');
        const now = new Date();
        const year = monthArg ? parseInt(monthArg.slice(0, 4), 10) : now.getUTCFullYear();
        const month = monthArg ? parseInt(monthArg.slice(5, 7), 10) : now.getUTCMonth() + 1;
        const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const toDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
        const result = await env.DB.prepare(`
          SELECT provider_refund_id, parent_yoco_order_id, occurred_at,
                 ABS(COALESCE(gross_total, total, 0)) AS gross_amount,
                 ABS(COALESCE(vat_total, 0)) AS vat_amount,
                 ABS(COALESCE(net_total, total, 0)) AS net_amount
            FROM yoco_orders
           WHERE workspace_id = ?1
             AND order_type = 'refund'
             AND occurred_at >= ?2
             AND occurred_at < ?3
           ORDER BY occurred_at DESC
        `).bind(workspaceId, `${fromDate}T00:00:00`, `${toDate}T00:00:00`).all<Record<string, unknown>>();
        const refunds = result.results || [];
        if (!refunds.length) return `No recorded refunds found for ${year}-${String(month).padStart(2, '0')}.`;
        const total = refunds.reduce((sum, row) => sum + numberValue(row.gross_amount, 0), 0);
        return JSON.stringify({
          source: 'KCP canonical Yoco V2 reporting records',
          month: `${year}-${String(month).padStart(2, '0')}`,
          total_refunded: `R${total.toFixed(2)}`,
          count: refunds.length,
          refunds: refunds.map((row) => ({
            date: String(row.occurred_at || '').slice(0, 10),
            amount: `R${numberValue(row.gross_amount, 0).toFixed(2)}`,
            vat: `R${numberValue(row.vat_amount, 0).toFixed(2)}`,
            net: `R${numberValue(row.net_amount, 0).toFixed(2)}`,
            order_id: String(row.parent_yoco_order_id || ''),
            refund_id: String(row.provider_refund_id || ''),
          })),
        });
      }

      case 'get_monthly_sales': {
        const monthArg = text(args.month || '');
        const now = new Date();
        const year = monthArg ? parseInt(monthArg.slice(0, 4), 10) : now.getUTCFullYear();
        const month = monthArg ? parseInt(monthArg.slice(5, 7), 10) : now.getUTCMonth() + 1;
        const fromDate = `${year}-${String(month).padStart(2, '0')}-01`;
        const toDate = month === 12 ? `${year + 1}-01-01` : `${year}-${String(month + 1).padStart(2, '0')}-01`;
        const result = await env.DB.prepare(`
          SELECT occurred_at, COALESCE(gross_total, total, 0) AS gross_amount,
                 COALESCE(vat_total, 0) AS vat_amount,
                 COALESCE(net_total, total, 0) AS net_amount
            FROM yoco_orders
           WHERE workspace_id = ?1
             AND order_type = 'sale'
             AND lower(COALESCE(status, 'completed')) IN ('completed', 'paid', 'succeeded')
             AND occurred_at >= ?2
             AND occurred_at < ?3
           ORDER BY occurred_at
        `).bind(workspaceId, `${fromDate}T00:00:00`, `${toDate}T00:00:00`).all<Record<string, unknown>>();
        const orders = result.results || [];
        if (!orders.length) return `No recorded completed sales found for ${year}-${String(month).padStart(2, '0')}.`;
        const totalRevenue = orders.reduce((sum, row) => sum + numberValue(row.gross_amount, 0), 0);
        const orderCount = orders.length;
        const byDay: Record<string, number> = {};
        for (const row of orders) {
          const day = String(row.occurred_at || '').slice(0, 10);
          if (day) byDay[day] = (byDay[day] || 0) + numberValue(row.gross_amount, 0);
        }
        return JSON.stringify({
          source: 'KCP canonical Yoco V2 reporting records',
          month: `${year}-${String(month).padStart(2, '0')}`,
          total_revenue: `R${totalRevenue.toFixed(2)}`,
          order_count: orderCount,
          avg_order_value: `R${(totalRevenue / orderCount).toFixed(2)}`,
          daily_breakdown: Object.entries(byDay).sort(([a], [b]) => a.localeCompare(b))
            .map(([day, revenue]) => ({ date: day, revenue: `R${revenue.toFixed(2)}` })),
        });
      }

      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (e) {
    return `Error fetching data: ${e instanceof Error ? e.message : 'unknown error'}`;
  }
}

function buildChartData(toolResults: Array<Record<string, unknown>>) {
  for (const tr of toolResults) {
    const content = String(tr.content || '');
    try {
      const parsed = JSON.parse(content);
      if (parsed?.daily_breakdown && Array.isArray(parsed.daily_breakdown) && parsed.daily_breakdown.length > 0) {
        return {
          labels: parsed.daily_breakdown.map((d: Record<string, unknown>) => String(d.date || '')),
          values: parsed.daily_breakdown.map((d: Record<string, unknown>) => parseFloat(String(d.revenue || '0').replace('R', '')) || 0),
          color: '#2563eb'
        };
      }
    } catch { /* not JSON */ }
  }
  return null;
}

export async function postWorkspaceChat(
  request: Request,
  env: Env,
  _auth: AuthContext,
  workspaceId: string
): Promise<Response> {
  if (!env.GROQ_API_KEY) {
    return error(request, env, 503, 'AI assistant is not configured. Please add a GROQ_API_KEY to the worker secrets.');
  }
  // Third-party API cost/quota risk, same class of problem as the Cloudflare quota issue this
  // whole rate-limit pass is about, different vendor. No limit existed before this.
  const aiLimited = await checkRateLimit(env.CENTRAL_DB, `ai-chat:${workspaceId}`, 20, 3600);
  if (aiLimited.blocked) return error(request, env, 429, 'The KCP Assistant has reached its hourly usage limit for this workspace. Please try again later.');

  const settingsRow = await env.DB.prepare(
    `SELECT raw_json FROM workspace_settings WHERE workspace_id = ?1 LIMIT 1`
  ).bind(workspaceId).first<{ raw_json: string }>();
  const wsSettings = (() => { try { return JSON.parse(settingsRow?.raw_json || '{}'); } catch { return {}; } })();
  if (wsSettings.chat_enabled !== true) {
    return error(request, env, 503, 'The KCP Assistant is disabled for this workspace.');
  }

  const payload = await request.json().catch(() => ({})) as Record<string, unknown>;
  const userMessage = text(payload.message || '');
  if (!userMessage) return error(request, env, 400, 'Message is required.');

  const rawHistory = Array.isArray(payload.history) ? payload.history : [];
  const history = rawHistory
    .filter((m: unknown) => m && typeof m === 'object')
    .map((m: unknown) => {
      const msg = m as Record<string, unknown>;
      return { role: text(msg.role || 'user'), content: text(msg.content || '') };
    })
    .filter((m) => m.role && m.content)
    .slice(-10); // keep last 10 turns for context

  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const currentMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const systemWithDate = `${SYSTEM_PROMPT}\n\nToday's date: ${todayStr}. Current month: ${currentMonth}. Use this for any time-relative questions ("last month", "this month", "today", etc.).`;

  const messages = [
    { role: 'system', content: systemWithDate },
    ...history,
    { role: 'user', content: userMessage }
  ];

  // First call to Groq — may return tool calls
  const firstResponse = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.GROQ_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      tools: TOOLS,
      tool_choice: 'auto',
      max_tokens: 1024,
      temperature: 0.3
    })
  });

  if (!firstResponse.ok) {
    const errBody = await firstResponse.text().catch(() => '');
    return error(request, env, 502, `AI service error: ${firstResponse.status}. ${errBody.slice(0, 200)}`);
  }

  const firstData = await firstResponse.json() as Record<string, unknown>;
  const firstChoice = (firstData.choices as Array<Record<string, unknown>>)?.[0];
  const assistantMessage = firstChoice?.message as Record<string, unknown>;

  // If Groq wants to call tools, execute them and get a final answer
  if (assistantMessage?.tool_calls && Array.isArray(assistantMessage.tool_calls) && assistantMessage.tool_calls.length > 0) {
    const toolResults: Array<Record<string, unknown>> = [];

    for (const toolCall of assistantMessage.tool_calls as Array<Record<string, unknown>>) {
      const fn = toolCall.function as Record<string, unknown>;
      const toolName = text(fn.name || '');
      let toolArgs: Record<string, unknown> = {};
      try { toolArgs = JSON.parse(text(fn.arguments || '{}')); } catch { /* use empty */ }

      const result = await executeTool(toolName, toolArgs, workspaceId, env);
      console.log(`[chat] tool=${toolName} workspace=${workspaceId} result_len=${String(result).length} preview=${String(result).slice(0, 80)}`);
      toolResults.push({
        role: 'tool',
        tool_call_id: text(toolCall.id || ''),
        content: result
      });
    }

    // Cap each tool result to avoid token overflow on second call
    const cappedToolResults = toolResults.map(tr => ({
      ...tr,
      content: String(tr.content || '').slice(0, 3000)
    }));

    // Second call — use a minimal system prompt (no knowledge base, just formatting rules)
    const formatPrompt = `You are KCP Assistant. Format the tool results below into a clear, concise response.
Use markdown tables for lists of data. Currency is South African Rand (R). Be brief — no preamble, no sign-off.
NEVER mention tool names. Just present the data.`;

    const secondResponse = await fetch(GROQ_API_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: 'system', content: formatPrompt },
          { role: 'user', content: userMessage },
          assistantMessage,
          ...cappedToolResults
        ],
        tool_choice: 'none',
        max_tokens: 1024,
        temperature: 0.2
      })
    });

    if (!secondResponse.ok) {
      const errBody = await secondResponse.text().catch(() => '');
      return error(request, env, 502, `AI follow-up error: ${secondResponse.status}. ${errBody.slice(0, 200)}`);
    }

    const secondData = await secondResponse.json() as Record<string, unknown>;
    const finalChoice = (secondData.choices as Array<Record<string, unknown>>)?.[0];
    const finalMessage = finalChoice?.message as Record<string, unknown>;
    const answer = text(finalMessage?.content || 'Sorry, I could not generate a response.');
    const chartData = buildChartData(toolResults);
    return json(request, env, { ok: true, answer, ...(chartData ? { chartData } : {}) });
  }

  // No tool calls — direct answer
  const answer = text(assistantMessage?.content || 'Sorry, I could not generate a response.');
  return json(request, env, { ok: true, answer });
}
