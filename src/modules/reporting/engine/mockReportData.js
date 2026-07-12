export const mockReportData = {
  stockItems: [
    {
      id: 'stk-beef',
      name: 'Beef Patty',
      category: 'RAW',
      unit: 'kg',
      unitCost: 120,
      sku: 'BEEF-001',
      locationStocks: [
        { locationId: 'main', openingQty: 25, actualClosingQty: 35 },
        { locationId: 'kitchen', openingQty: 12, actualClosingQty: 8.5 }
      ]
    },
    {
      id: 'stk-bun',
      name: 'Burger Bun',
      category: 'PREP',
      unit: 'ea',
      unitCost: 4.5,
      sku: 'BUN-001',
      locationStocks: [
        { locationId: 'main', openingQty: 80, actualClosingQty: 68 },
        { locationId: 'kitchen', openingQty: 20, actualClosingQty: 41 }
      ]
    },
    {
      id: 'stk-sauce',
      name: 'House Sauce',
      category: 'PREP',
      unit: 'l',
      unitCost: 35,
      sku: 'SAUCE-001',
      locationStocks: [
        { locationId: 'kitchen', openingQty: 8, actualClosingQty: 12.8 }
      ]
    },
    {
      id: 'stk-cheese',
      name: 'Cheese Slice',
      category: 'RAW',
      unit: 'ea',
      unitCost: 2.25,
      sku: 'CHEESE-001',
      locationStocks: [
        { locationId: 'main', openingQty: 120, actualClosingQty: 168 },
        { locationId: 'kitchen', openingQty: 30, actualClosingQty: 29 }
      ]
    }
  ],
  locations: [
    { id: 'main', name: 'Main Store' },
    { id: 'kitchen', name: 'Kitchen' },
    { id: 'bar', name: 'Bar' }
  ],
  grvs: [
    {
      id: 'grv-1',
      grvNumber: 'GRV-001',
      invoice: 'INV-001',
      date: '2026-07-08',
      timestamp: '2026-07-08T08:00:00+02:00',
      locationId: 'main',
      locationName: 'Main Store',
      submittedByName: 'Manager',
      items: [{ stockItemId: 'stk-beef', stockItemName: 'Beef Patty', receivedQty: 10, unit: 'kg', unitCost: 120, locationId: 'main', locationName: 'Main Store' }]
    },
    {
      id: 'grv-po-1',
      grvNumber: 'GRV-PO-001',
      poNumber: 'PO-001',
      sourcePoId: 'po-1',
      date: '2026-07-08',
      timestamp: '2026-07-08T08:30:00+02:00',
      locationId: 'main',
      locationName: 'Main Store',
      submittedByName: 'Manager',
      items: [{ stockItemId: 'stk-cheese', stockItemName: 'Cheese Slice', receivedQty: 50, unit: 'ea', unitCost: 2.25, locationId: 'main', locationName: 'Main Store' }]
    }
  ],
  creditNotes: [
    {
      id: 'cn-1',
      cnNumber: 'CN-001',
      date: '2026-07-08',
      timestamp: '2026-07-08T08:45:00+02:00',
      locationId: 'main',
      locationName: 'Main Store',
      createdByName: 'Manager',
      notes: 'Supplier return',
      items: [{ stockItemId: 'stk-cheese', stockItemName: 'Cheese Slice', returnedQty: 2, unit: 'ea', unitCost: 2.25 }]
    }
  ],
  adjustments: [
    {
      id: 'adj-1',
      date: '2026-07-08',
      timestamp: '2026-07-08T09:30:00+02:00',
      mode: 'wastage',
      itemId: 'stk-beef',
      itemName: 'Beef Patty',
      category: 'RAW',
      locationId: 'kitchen',
      locationName: 'Kitchen',
      qty: 2,
      unit: 'kg',
      unitCost: 120,
      wasteReason: 'Overcooked',
      user: 'Manager'
    },
    {
      id: 'adj-2',
      date: '2026-07-08',
      timestamp: '2026-07-08T11:00:00+02:00',
      mode: 'add',
      itemId: 'stk-bun',
      itemName: 'Burger Bun',
      category: 'PREP',
      locationId: 'main',
      locationName: 'Main Store',
      qty: 12,
      unit: 'ea',
      unitCost: 4.5,
      note: 'Manual correction',
      user: 'Manager'
    }
  ],
  transfers: [
    {
      id: 'tf-1',
      date: '2026-07-08',
      timestamp: '2026-07-08T10:00:00+02:00',
      from: 'main',
      fromName: 'Main Store',
      to: 'kitchen',
      toName: 'Kitchen',
      user: 'Manager',
      items: [{ stockItemId: 'stk-bun', name: 'Burger Bun', qty: 24, unit: 'ea' }]
    }
  ],
  stockTakes: [
    {
      id: 'st-1',
      date: '2026-07-08',
      timestamp: '2026-07-08T18:00:00+02:00',
      locationId: 'kitchen',
      locationName: 'Kitchen',
      user: 'Manager',
      items: [{ stockItemId: 'stk-beef', stockItemName: 'Beef Patty', systemStock: 10, shelfCount: 9, variance: -1, unit: 'kg', cost: 120 }]
    }
  ],
  manufacturingLogs: [
    {
      id: 'mfg-1',
      date: '2026-07-08',
      timestamp: '2026-07-08T14:00:00+02:00',
      itemId: 'stk-sauce',
      itemName: 'House Sauce',
      locationId: 'kitchen',
      locationName: 'Kitchen',
      producedQty: 5,
      wastageQty: 0.2,
      unit: 'l',
      unitCost: 35,
      user: 'Chef',
      components: [{ stockItemId: 'stk-beef', stockItemName: 'Beef Patty', qty: 0.5, unit: 'kg', unitCost: 120 }]
    }
  ],
  saleUsage: [
    {
      id: 'sale-1',
      receiptNumber: 'SALE-001',
      timestamp: '2026-07-08T15:00:00+02:00',
      stockItemId: 'stk-bun',
      stockItemName: 'Burger Bun',
      locationId: 'kitchen',
      locationName: 'Kitchen',
      qty: 3,
      unit: 'ea',
      unitCost: 4.5,
      productName: 'Classic Burger'
    }
  ],
  modifierUsage: [
    {
      id: 'mod-sale-1',
      receiptNumber: 'SALE-001',
      timestamp: '2026-07-08T15:05:00+02:00',
      stockItemId: 'stk-cheese',
      stockItemName: 'Cheese Slice',
      locationId: 'kitchen',
      locationName: 'Kitchen',
      qty: 1,
      unit: 'ea',
      unitCost: 2.25,
      modifierName: 'Extra Cheese'
    }
  ]
};

export default mockReportData;
