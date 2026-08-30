export const REPORTING_DATABASE_REQUIREMENTS = [
  {
    reportId: 'sales_reports',
    label: 'Sales Reports',
    tables: {
      yoco_orders: ['workspace_id', 'yoco_order_id', 'yoco_payment_id', 'location_id', 'order_type', 'status', 'payment_method', 'total', 'occurred_at', 'raw_json'],
      yoco_order_lines: ['workspace_id', 'yoco_order_id', 'product_id', 'yoco_line_id', 'name', 'quantity', 'total', 'selling_location_id', 'source_location_id', 'raw_json'],
      stock_movements: ['workspace_id', 'stock_item_id', 'location_id', 'movement_type', 'document_type', 'document_id', 'quantity_delta', 'unit_cost', 'value_delta', 'occurred_at', 'metadata_json'],
      products: ['workspace_id', 'name', 'category', 'price', 'external_provider', 'yoco_item_id', 'yoco_variant_id', 'yoco_category_id', 'raw_json'],
      stock_items: ['workspace_id', 'name', 'category', 'item_type', 'unit', 'unit_cost', 'threshold_qty', 'par_level_qty', 'raw_json'],
      locations: ['workspace_id', 'name', 'display_name', 'external_provider', 'external_location_id', 'stock_routing_json'],
      workspace_settings: ['workspace_id', 'vat_rate']
    }
  },
  {
    reportId: 'modifier_report',
    label: 'Modifier Report',
    tables: {
      yoco_orders: ['workspace_id', 'yoco_order_id', 'yoco_payment_id', 'location_id', 'status', 'payment_method', 'total', 'occurred_at', 'raw_json'],
      yoco_order_lines: ['workspace_id', 'yoco_order_id', 'product_id', 'yoco_line_id', 'name', 'quantity', 'total', 'raw_json'],
      yoco_modifier_groups: ['workspace_id', 'yoco_modifier_group_id', 'name', 'min_selections', 'max_selections', 'product_modifier_count', 'raw_json'],
      stock_movements: ['workspace_id', 'stock_item_id', 'location_id', 'movement_type', 'document_type', 'document_id', 'quantity_delta', 'unit_cost', 'value_delta', 'occurred_at', 'metadata_json'],
      stock_items: ['workspace_id', 'name', 'category', 'unit', 'unit_cost'],
      products: ['workspace_id', 'name', 'category', 'yoco_item_id', 'yoco_variant_id', 'raw_json'],
      locations: ['workspace_id', 'name', 'display_name'],
      workspace_settings: ['workspace_id', 'vat_rate']
    }
  },
  {
    reportId: 'menu_recipe_health',
    label: 'Menu & Recipe Health',
    tables: {
      products: ['workspace_id', 'name', 'category', 'price', 'yoco_item_id', 'yoco_variant_id', 'yoco_category_id', 'missing_recipe', 'recipe_source_stock_item_id', 'raw_json'],
      product_location_prices: ['workspace_id', 'product_id', 'location_id', 'price', 'source', 'updated_at'],
      yoco_categories: ['workspace_id', 'yoco_category_id', 'name', 'raw_json'],
      recipes: ['workspace_id', 'owner_type', 'owner_id', 'yield_qty', 'yield_unit', 'linked_product_id', 'active'],
      recipe_lines: ['workspace_id', 'recipe_id', 'stock_item_id', 'quantity', 'unit'],
      stock_items: ['workspace_id', 'name', 'category', 'item_type', 'unit', 'unit_cost', 'is_stocked', 'raw_json'],
      stock_balances: ['workspace_id', 'stock_item_id', 'location_id', 'quantity'],
      stock_item_location_prices: ['workspace_id', 'stock_item_id', 'location_id', 'price'],
      yoco_orders: ['workspace_id', 'yoco_order_id', 'location_id', 'total', 'occurred_at'],
      yoco_order_lines: ['workspace_id', 'yoco_order_id', 'product_id', 'quantity', 'total'],
      stock_movements: ['workspace_id', 'stock_item_id', 'location_id', 'document_type', 'document_id', 'quantity_delta', 'value_delta', 'occurred_at', 'metadata_json'],
      locations: ['workspace_id', 'name', 'display_name'],
      workspace_settings: ['workspace_id', 'vat_rate']
    }
  },
  {
    reportId: 'stock_control',
    label: 'Stock Control',
    tables: {
      stock_items: ['workspace_id', 'name', 'category', 'item_type', 'unit', 'unit_cost', 'threshold_qty', 'par_level_qty', 'is_stocked', 'raw_json'],
      stock_balances: ['workspace_id', 'stock_item_id', 'location_id', 'quantity', 'updated_at'],
      stock_item_location_prices: ['workspace_id', 'stock_item_id', 'location_id', 'price', 'updated_at'],
      locations: ['workspace_id', 'name', 'display_name', 'active'],
      suppliers: ['workspace_id', 'name', 'active'],
      grvs: ['workspace_id', 'supplier_id', 'received_at'],
      grv_lines: ['workspace_id', 'grv_id', 'stock_item_id', 'location_id', 'quantity', 'unit', 'unit_price']
    }
  },
  {
    reportId: 'stock_on_hand',
    label: 'Stock on Hand',
    tables: {
      stock_items: ['workspace_id', 'name', 'category', 'item_type', 'unit', 'unit_cost', 'vat_enabled', 'threshold_qty', 'par_level_qty', 'is_stocked', 'raw_json'],
      stock_balances: ['workspace_id', 'stock_item_id', 'location_id', 'quantity', 'updated_at'],
      stock_item_location_prices: ['workspace_id', 'stock_item_id', 'location_id', 'price', 'updated_at'],
      stock_movements: ['workspace_id', 'stock_item_id', 'location_id', 'movement_type', 'document_type', 'document_id', 'quantity_delta', 'unit_cost', 'value_delta', 'occurred_at'],
      grvs: ['workspace_id', 'supplier_id', 'received_at'],
      grv_lines: ['workspace_id', 'grv_id', 'stock_item_id', 'location_id', 'quantity', 'unit_price'],
      suppliers: ['workspace_id', 'name'],
      locations: ['workspace_id', 'name', 'display_name', 'active']
    }
  },
  {
    reportId: 'purchase_orders_report',
    label: 'Purchase Orders',
    tables: {
      purchase_orders: ['workspace_id', 'supplier_id', 'status', 'po_number', 'target_location_id', 'ordered_at', 'expected_at', 'total_ex', 'total_vat', 'total_inc', 'raw_json'],
      purchase_order_lines: ['workspace_id', 'purchase_order_id', 'stock_item_id', 'description', 'quantity', 'unit', 'unit_price', 'total_ex', 'total_vat', 'total_inc'],
      grvs: ['workspace_id', 'supplier_id', 'purchase_order_id', 'received_at'],
      grv_lines: ['workspace_id', 'grv_id', 'stock_item_id', 'location_id', 'quantity', 'total_ex'],
      suppliers: ['workspace_id', 'name'],
      locations: ['workspace_id', 'name', 'display_name'],
      stock_items: ['workspace_id', 'name', 'category', 'unit']
    }
  },
  {
    reportId: 'grv_log',
    label: 'GRV Log',
    tables: {
      grvs: ['workspace_id', 'supplier_id', 'purchase_order_id', 'invoice_number', 'received_at', 'total_ex', 'total_vat', 'total_inc', 'created_by', 'raw_json'],
      grv_lines: ['workspace_id', 'grv_id', 'stock_item_id', 'location_id', 'quantity', 'unit', 'unit_price', 'total_ex', 'total_vat', 'total_inc'],
      stock_movements: ['workspace_id', 'stock_item_id', 'location_id', 'document_type', 'document_id', 'quantity_delta', 'value_delta', 'occurred_at'],
      suppliers: ['workspace_id', 'name'],
      locations: ['workspace_id', 'name', 'display_name'],
      stock_items: ['workspace_id', 'name', 'category', 'unit']
    }
  },
  {
    reportId: 'credit_notes_report',
    label: 'Credit Notes',
    tables: {
      credit_notes: ['workspace_id', 'supplier_id', 'credit_note_number', 'credited_at', 'location_id', 'reason', 'total_ex', 'prices_include_vat', 'created_by', 'raw_json'],
      credit_note_lines: ['workspace_id', 'credit_note_id', 'stock_item_id', 'location_id', 'quantity', 'unit', 'unit_cost', 'total_ex'],
      stock_movements: ['workspace_id', 'stock_item_id', 'location_id', 'document_type', 'document_id', 'quantity_delta', 'value_delta', 'occurred_at'],
      workspace_settings: ['workspace_id', 'vat_rate'],
      suppliers: ['workspace_id', 'name'],
      locations: ['workspace_id', 'name', 'display_name'],
      stock_items: ['workspace_id', 'name', 'category', 'unit', 'vat_enabled']
    }
  },
  {
    reportId: 'inventory_audit',
    label: 'Inventory Audit',
    tables: {
      audit_events: ['workspace_id', 'actor_uid', 'event_type', 'entity_type', 'entity_id', 'before_json', 'after_json', 'created_at'],
      stock_movements: ['workspace_id', 'stock_item_id', 'location_id', 'movement_type', 'document_type', 'document_id', 'quantity_delta', 'unit_cost', 'value_delta', 'occurred_at', 'created_by', 'metadata_json'],
      stock_items: ['workspace_id', 'name', 'category', 'unit', 'unit_cost', 'raw_json'],
      products: ['workspace_id', 'name', 'category', 'price', 'raw_json'],
      recipes: ['workspace_id', 'owner_type', 'owner_id', 'linked_product_id', 'active'],
      recipe_lines: ['workspace_id', 'recipe_id', 'stock_item_id', 'quantity', 'unit'],
      suppliers: ['workspace_id', 'name'],
      locations: ['workspace_id', 'name', 'display_name']
    }
  },
  {
    reportId: 'operations',
    label: 'Operations reports',
    tables: {
      stock_movements: ['workspace_id', 'stock_item_id', 'location_id', 'movement_type', 'document_type', 'document_id', 'source_location_id', 'destination_location_id', 'quantity_delta', 'unit_cost', 'value_delta', 'occurred_at', 'created_by', 'metadata_json', 'created_at'],
      stock_items: ['workspace_id', 'name', 'category', 'item_type', 'unit', 'unit_cost', 'threshold_qty', 'raw_json'],
      stocktake_sessions: ['workspace_id', 'status', 'counted_at', 'created_by', 'raw_json'],
      stocktake_count_lines: ['workspace_id', 'stocktake_session_id', 'stock_item_id', 'location_id', 'expected_qty', 'counted_qty', 'variance_qty', 'unit_cost'],
      adjustments: ['workspace_id', 'adjustment_type', 'occurred_at', 'reason', 'created_by', 'raw_json'],
      adjustment_lines: ['workspace_id', 'adjustment_id', 'stock_item_id', 'location_id', 'quantity_delta', 'unit_cost'],
      transfers: ['workspace_id', 'from_location_id', 'to_location_id', 'status', 'note'],
      transfer_lines: ['workspace_id', 'transfer_id', 'stock_item_id', 'quantity', 'unit_cost'],
      manufacturing_batches: ['workspace_id', 'stock_item_id', 'location_id', 'quantity_made', 'actual_quantity', 'wastage_quantity', 'raw_json'],
      manufacturing_batch_lines: ['workspace_id', 'manufacturing_batch_id', 'component_stock_item_id', 'location_id', 'quantity_used', 'unit_cost'],
      grvs: ['workspace_id', 'supplier_id', 'purchase_order_id', 'invoice_number', 'received_at', 'created_by', 'raw_json'],
      grv_lines: ['workspace_id', 'grv_id', 'stock_item_id', 'location_id', 'quantity', 'unit', 'unit_price'],
      credit_notes: ['workspace_id', 'supplier_id', 'credit_note_number', 'credited_at', 'location_id', 'reason', 'created_by', 'raw_json'],
      credit_note_lines: ['workspace_id', 'credit_note_id', 'stock_item_id', 'location_id', 'quantity', 'unit_cost'],
      yoco_orders: ['workspace_id', 'yoco_order_id', 'location_id', 'occurred_at'],
      locations: ['workspace_id', 'name', 'display_name']
    }
  }
];

export function auditReportingDatabaseContract(schemaText = '', requirements = REPORTING_DATABASE_REQUIREMENTS) {
  const schema = String(schemaText || '');
  return requirements.map((requirement) => {
    const tables = Object.entries(requirement.tables || {}).map(([tableName, requiredColumns]) => {
      const tableFound = hasTable(schema, tableName);
      const missingColumns = tableFound
        ? requiredColumns.filter((column) => !hasColumn(schema, tableName, column))
        : [...requiredColumns];
      return {
        tableName,
        tableFound,
        requiredColumns: [...requiredColumns],
        missingColumns,
        ok: tableFound && missingColumns.length === 0
      };
    });
    return {
      reportId: requirement.reportId,
      label: requirement.label,
      tables,
      ok: tables.every((table) => table.ok)
    };
  });
}

export function summarizeReportingDatabaseAudit(audit = []) {
  const failedReports = audit.filter((report) => !report.ok);
  const missingTables = [];
  const missingColumns = [];
  failedReports.forEach((report) => {
    report.tables.forEach((table) => {
      if (!table.tableFound) {
        missingTables.push(`${report.reportId}:${table.tableName}`);
        return;
      }
      table.missingColumns.forEach((column) => missingColumns.push(`${report.reportId}:${table.tableName}.${column}`));
    });
  });
  return {
    ok: failedReports.length === 0,
    reportCount: audit.length,
    failedReportCount: failedReports.length,
    missingTables,
    missingColumns
  };
}

function hasTable(schema, tableName) {
  const escaped = escapeRegExp(tableName);
  return new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${escaped}\\b`, 'i').test(schema);
}

function hasColumn(schema, tableName, columnName) {
  const escapedTable = escapeRegExp(tableName);
  const escapedColumn = escapeRegExp(columnName);
  const createTableMatch = schema.match(new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${escapedTable}\\s*\\(([^;]+?)\\);`, 'is'));
  const createBlock = createTableMatch?.[1] || '';
  if (new RegExp(`(^|[,\\s])${escapedColumn}\\s+`, 'i').test(createBlock)) return true;
  return new RegExp(`ALTER\\s+TABLE\\s+${escapedTable}\\s+ADD\\s+COLUMN\\s+${escapedColumn}\\b`, 'i').test(schema);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
