export const formulaTooltips = {
  stockValue: {
    label: 'Stock Value',
    formula: 'Current Stock x Unit Cost Ex VAT',
    description: 'Location-specific stock quantity multiplied by the applicable unit cost excluding VAT.'
  },
  netMovement: {
    label: 'Net Movement',
    formula: 'Qty In - Qty Out',
    description: 'Positive values increase stock. Negative values reduce stock.'
  },
  movementValue: {
    label: 'Movement Value',
    formula: 'Net Qty x Unit Cost Ex VAT',
    description: 'Signed value of the stock movement. Increases are positive and decreases are negative.'
  },
  runningQty: {
    label: 'Running Qty',
    formula: 'Previous Running Qty + Net Qty',
    description: 'Running stock balance for the item at the selected ledger location.'
  },
  runningValue: {
    label: 'Running Value',
    formula: 'Running Qty x Unit Cost Ex VAT',
    description: 'Running quantity multiplied by the movement row unit cost.'
  },
  unitCostExVat: {
    label: 'Unit Cost Ex VAT',
    formula: 'Base item cost excluding VAT',
    description: 'Used as the cost basis for movement value and running value calculations.'
  },
  expectedClosingQty: {
    label: 'Expected Closing Qty',
    formula: 'Opening Qty + Stock In Qty - Stock Out Qty',
    description: 'Expected item quantity after purchases, usage, wastage, transfers, manufacturing, and adjustments are applied.'
  },
  varianceQty: {
    label: 'Variance Qty',
    formula: 'Counted Qty - Expected Qty',
    description: 'Positive means counted more than expected. Negative means counted less than expected.'
  },
  operationsVarianceQty: {
    label: 'Variance Qty',
    formula: 'Actual Closing Qty - Expected Closing Qty',
    description: 'Quantity difference between actual closing stock and expected closing stock.'
  },
  varianceValue: {
    label: 'Variance Value',
    formula: 'Variance Qty x Unit Cost',
    description: 'Monetary value of the stock count variance.'
  },
  expectedClosingValue: {
    label: 'Expected Closing Value',
    formula: 'Opening Stock Value + Stock In - Stock Out',
    description: 'Expected stock value after purchases, usage, wastage, transfers, manufacturing, and adjustments are applied.'
  },
  operationsVarianceValue: {
    label: 'Variance Value',
    formula: 'Actual Closing Value - Expected Closing Value',
    description: 'Difference between actual closing stock value and expected closing stock value.'
  },
  netStockMovement: {
    label: 'Net Stock Movement',
    formula: 'Stock In - Stock Out',
    description: 'Positive values mean stock value increased. Negative values mean stock value reduced.'
  },
  variancePercent: {
    label: 'Variance Percent',
    formula: 'Variance / Expected Closing',
    description: 'Shows the variance size relative to expected closing value. Totals recalculate the percentage from total values rather than summing percentages.'
  },
  qtyWasted: {
    label: 'Qty Wasted',
    formula: 'Qty Wasted = Qty Out from wastage movement',
    description: 'Uses the recorded base-UOM quantity from true wastage movements such as wastage adjustments and manufacturing wastage. Stock take variance is reported separately and is never treated as wastage.'
  },
  wastageValue: {
    label: 'Wastage Value',
    formula: 'Qty Wasted x Unit Cost Ex VAT',
    description: 'Displays the absolute Rand value of stock lost while preserving the original negative movement direction in the ledger.'
  },
  percentOfTotalWastage: {
    label: '% of Total Wastage',
    formula: 'Source Wastage Value / Total Wastage Value',
    description: 'Shows how much of the selected period wastage value came from this source, category, or item group.'
  },
  stockTakeExpectedValue: {
    label: 'Expected Value',
    formula: 'Expected Qty x Unit Cost Ex VAT',
    description: 'System stock quantity at count time multiplied by the item cost basis.'
  },
  stockTakeCountedValue: {
    label: 'Counted Value',
    formula: 'Counted Qty x Unit Cost Ex VAT',
    description: 'Committed counted base quantity multiplied by the item cost basis.'
  },
  stockTakeVarianceQty: {
    label: 'Variance Qty',
    formula: 'Counted Qty - Expected Qty',
    description: 'Positive values mean the count was higher than system stock. Negative values mean the count was lower.'
  },
  stockTakeVarianceValue: {
    label: 'Variance Value',
    formula: 'Counted Value - Expected Value',
    description: 'Rand value impact of the stock take variance.'
  },
  stockTakeVariancePercent: {
    label: 'Variance %',
    formula: 'Variance Value / Expected Value',
    description: 'Variance size relative to expected stock value. Totals recalculate this from total values.'
  },
  convertedBaseQty: {
    label: 'Converted Base Qty',
    formula: 'Counted Qty x UOM Ratio',
    description: 'Converts counted stock take quantity into the stock item base UOM.'
  },

  adjustmentQty: {
    label: 'Qty Adjusted',
    formula: 'Qty In - Qty Out',
    description: 'Signed adjustment quantity. Positive adjustments increase stock and negative adjustments decrease stock.'
  },
  adjustmentValue: {
    label: 'Value Impact',
    formula: 'Qty Adjusted x Unit Cost Ex VAT',
    description: 'Signed Rand value impact of the adjustment movement.'
  },
  qtyAfter: {
    label: 'Qty After',
    formula: 'Qty Before + Qty Adjusted',
    description: 'Closing stock quantity after the adjustment. If before/after are not stored, this is derived from running quantity where available.'
  },
  positiveAdjustment: {
    label: 'Positive Adjustment',
    formula: 'Positive adjustment increases stock',
    description: 'Positive adjustment values come from movements where Net Qty is greater than zero.'
  },
  negativeAdjustment: {
    label: 'Negative Adjustment',
    formula: 'Negative adjustment decreases stock',
    description: 'Negative adjustment values come from movements where Net Qty is less than zero and are displayed as positive loss values in grouped summaries.'
  },
  transferValue: {
    label: 'Transfer Value',
    formula: 'Transfer Value = Qty Transferred x Unit Cost Ex VAT',
    description: 'Uses the transfer quantity and the item cost at the time of transfer.'
  },
  netTransferQty: {
    label: 'Net Transfer Qty',
    formula: 'Net Transfer Qty = Transfers In Qty - Transfers Out Qty',
    description: 'Positive means the selected location received more stock than it sent out. Negative means it sent out more stock than it received.'
  },
  netTransferValue: {
    label: 'Net Transfer Value',
    formula: 'Net Transfer Value = Transfers In Value - Transfers Out Value',
    description: 'Positive means transfer value increased at the selected location. Negative means transfer value decreased.'
  },
  netSales: {
    label: 'Net Sales',
    formula: 'Gross Amount - VAT Amount',
    description: 'Sales value excluding VAT before the separate refund and fee deductions used to calculate payout.'
  },
  grossProfit: {
    label: 'Gross Profit',
    formula: 'Net Sales - Stock Cost',
    description: 'Menu or modifier sales value excluding VAT less ingredient stock cost.'
  },
  gpPercent: {
    label: 'GP %',
    formula: 'Gross Profit / Net Sales',
    description: 'Gross profit as a percentage of net sales. Totals recalculate from total GP and total net sales.'
  },
  foodCostPercent: {
    label: 'Food Cost %',
    formula: 'Stock Cost / Net Sales',
    description: 'Ingredient cost as a percentage of net sales.'
  },

  grossSales: {
    label: 'Gross Sales',
    formula: 'Total sales including VAT before separating VAT',
    description: 'Gross sales stay separate from net sales and payout amount.'
  },
  salesVat: {
    label: 'VAT',
    formula: 'Gross Sales - Net Sales',
    description: 'VAT portion extracted from VAT-inclusive sales where the source does not store VAT separately.'
  },
  discounts: {
    label: 'Discounts',
    formula: 'Discounts reduce recognised sales value',
    description: 'Discounts remain separate from refunds, tips, fees, and generic adjustments.'
  },
  refunds: {
    label: 'Refunds',
    formula: 'VAT-exclusive refund value deducted from payout',
    description: 'Refunds remain separate so payout can be checked as Net Sales + Tips - Refunds - Fees.'
  },
  tips: {
    label: 'Tips',
    formula: 'Tips are reported separately from sales',
    description: 'Tips can affect payout but are not mixed into net sales.'
  },
  fees: {
    label: 'Fees',
    formula: 'Payment or processing fees',
    description: 'Fees affect payout and remain separate from net sales.'
  },
  payoutAmount: {
    label: 'Payout Amount',
    formula: 'Net Sales + Tips - Refunds - Fees',
    description: 'Payout is the VAT-exclusive sales value plus tips, less VAT-exclusive refunds and processing fees.'
  },
  averageTransactionValue: {
    label: 'Average Transaction Value',
    formula: 'Gross Sales / Transaction Count',
    description: 'Totals recalculate from total gross sales and total transaction count.'
  },
  stockValueUsed: {
    label: 'Stock Value Used',
    formula: 'Qty Used x Unit Cost Ex VAT',
    description: 'Ingredient stock usage value from sale and modifier usage movement rows.'
  },
  totalStockValueUsed: {
    label: 'Total Stock Value Used',
    formula: 'Recipe Stock Value Used + Modifier Stock Value Used',
    description: 'Keeps recipe cost and modifier cost separate before combining for GP.'
  },
  recipeQtyUsed: {
    label: 'Recipe Qty Used',
    formula: 'Qty Sold x Recipe Ingredient Qty',
    description: 'Explains how ingredient usage was reached per menu item sold.'
  },
  selectedPercent: {
    label: 'Selected %',
    formula: 'Times Selected / Total Selections in Modifier Group',
    description: 'Shows how often this modifier was selected within its modifier group.'
  },
  averageSellingPrice: {
    label: 'Average Selling Price',
    formula: 'Gross Sales / Qty Selected',
    description: 'Average gross amount charged for the modifier selection.'
  },
  stockCost: {
    label: 'Stock Cost',
    formula: 'Qty Deducted x Unit Cost Ex VAT',
    description: 'Stock cost for product modifiers and mapped note modifiers.'
  },

  sellingPriceExVat: {
    label: 'Selling Price Ex VAT',
    formula: 'Selling Price Incl VAT - VAT',
    description: 'VAT-exclusive selling price used for menu GP and food cost calculations.'
  },
  recipeCostExVat: {
    label: 'Recipe Cost Ex VAT',
    formula: 'Sum of ingredient line costs',
    description: 'Total recipe ingredient cost excluding VAT after sub-recipes are exploded to final stock ingredients.'
  },
  lineCost: {
    label: 'Line Cost',
    formula: 'Qty Required x Unit Cost Ex VAT',
    description: 'Cost of one recipe ingredient line after conversion to base UOM.'
  },
  menuGpPercent: {
    label: 'GP %',
    formula: 'Gross Profit / Selling Price Ex VAT',
    description: 'Menu gross profit as a percentage of selling price excluding VAT.'
  },
  source: {
    label: 'Source',
    formula: 'Movement origin',
    description: 'Identifies whether the row came from GRV, credit note, purchase order receive, adjustment, wastage, manufacturing, stock take, transfer, sale usage, or modifier usage.'
  },
  requiredQty: {
    label: 'Required Qty',
    formula: 'Par Level - Current Stock',
    description: 'Quantity required to bring the item back to par. If par is missing, the low stock threshold can be used as a fallback and a warning is shown.'
  },
  estimatedReorderValue: {
    label: 'Estimated Reorder Value',
    formula: 'Required Qty x Unit Cost Ex VAT',
    description: 'Estimated Rand value needed to replenish the required base quantity.'
  },
  purchaseUomQty: {
    label: 'Purchase UOM Qty',
    formula: 'Required Qty / Purchase UOM Conversion Ratio',
    description: 'Converts required base quantity into supplier purchase units where a purchase UOM conversion exists.'
  },
  stockControlStatus: {
    label: 'Status',
    formula: 'Critical, Low, Below Par, or Healthy',
    description: 'Critical = Current Stock <= 0. Low = Current Stock > 0 and <= Low Stock Threshold. Below Par = Current Stock > Low Stock Threshold and < Par Level. Healthy = Current Stock >= Par Level.'
  },
  auditCostDifference: {
    label: 'Cost Difference',
    formula: 'New Cost - Old Cost',
    description: 'Difference between the new and previous cost excluding VAT.'
  },
  auditChangePercent: {
    label: 'Change %',
    formula: 'Cost Difference / Old Cost',
    description: 'Percentage impact of a cost change. It is recalculated from row values and not summed directly.'
  },
  auditCostImpactDifference: {
    label: 'Cost Impact Difference',
    formula: 'New Cost Impact - Old Cost Impact',
    description: 'Recipe cost impact change caused by ingredient, quantity, UOM, or cost edits.'
  },
  auditHighRiskActions: {
    label: 'High Risk Actions',
    formula: 'Cost, quantity, recipe, UOM, deletion, or stock-affecting commits',
    description: 'Counts changes that can materially alter inventory value, recipes, stock balances, or traceability.'
  },
  stockOnHandStatus: {
    label: 'Status',
    formula: 'Critical, Low, Below Par, or Healthy',
    description: 'Critical = Current Stock <= 0. Low = Current Stock > 0 and <= Low Stock Threshold. Below Par = Current Stock > Low Stock Threshold and < Par Level. Healthy = Current Stock >= Par Level.'
  },
  poLineValueExVat: {
    label: 'Line Value Ex VAT',
    formula: 'Qty Ordered x Unit Cost Ex VAT',
    description: 'Purchase order line value excluding VAT.'
  },
  qtyOutstanding: {
    label: 'Qty Outstanding',
    formula: 'Qty Ordered - Qty Received',
    description: 'Quantity still expected against the purchase order line.'
  },
  outstandingValue: {
    label: 'Outstanding Value',
    formula: 'Total Value Ex VAT - Received Value',
    description: 'Value excluding VAT that has not yet been received through linked GRVs.'
  },
  grvLineValueExVat: {
    label: 'Line Value Ex VAT',
    formula: 'Received Qty x Unit Cost Ex VAT',
    description: 'Value excluding VAT for a goods received line.'
  },
  grvTotalValueExVat: {
    label: 'Total Value Ex VAT',
    formula: 'Sum of GRV line values',
    description: 'Sum of all GRV line values excluding VAT.'
  },
  creditLineValueExVat: {
    label: 'Line Credit Ex VAT',
    formula: 'Qty Credited x Unit Cost Ex VAT',
    description: 'Supplier credit line value excluding VAT.'
  },

  averageDailyUsage: {
    label: 'Average Daily Usage',
    formula: 'Total Usage / Lookback Days',
    description: 'Average base-UOM consumption per day over the selected lookback period.'
  },
  weightedDailyUsage: {
    label: 'Weighted Daily Usage',
    formula: '(7-day average x 50%) + (14-day average x 30%) + (30-day average x 20%)',
    description: 'Weights recent usage more heavily while retaining longer-term demand context.'
  },
  daysUntilStockOut: {
    label: 'Days Until Stock-Out',
    formula: 'Current Stock / Effective Daily Usage',
    description: 'Estimated days of location-specific stock coverage based on recent usage.'
  },
  forecastStockOutDate: {
    label: 'Forecast Stock-Out Date',
    formula: 'As-Of Date + Days Until Stock-Out',
    description: 'Estimated calendar date when the current location stock reaches zero. The date is rounded up to the next whole day.'
  },
  coveragePercent: {
    label: 'Coverage %',
    formula: 'Current Stock / Par Level',
    description: 'Current stock expressed as a percentage of the configured par level.'
  },
  recommendedReorderQty: {
    label: 'Recommended Reorder Qty',
    formula: 'max(Par Level - Current Stock, 0)',
    description: 'Base-UOM quantity required to restore the item to par.'
  },
  advancedRiskScore: {
    label: 'Risk Score',
    formula: '35% probability + 30% financial impact + 25% urgency + 10% data risk',
    description: 'A 0-100 prioritisation score. Lower data confidence increases the data-risk component rather than hiding the row.'
  },
  dataConfidence: {
    label: 'Data Confidence',
    formula: 'Available required inputs / expected required inputs',
    description: 'Indicates how complete the stock, cost, usage, supplier, recipe, and stock-take inputs are for the calculation.'
  },
  weightedAverageCost: {
    label: 'Weighted Average Cost',
    formula: 'Sum(Qty Purchased x Unit Cost) / Sum(Qty Purchased)',
    description: 'Purchase cost weighted by received quantity, excluding VAT.'
  },
  priceRange: {
    label: 'Price Range',
    formula: 'Highest Cost - Lowest Cost',
    description: 'Absolute spread between the highest and lowest purchase costs in the selected period.'
  },
  costChange: {
    label: 'Cost Change',
    formula: 'Last Cost - First Cost',
    description: 'Absolute movement from the first to the latest purchase cost in the selected period.'
  },
  costChangePercent: {
    label: 'Cost Change %',
    formula: '(Last Cost - First Cost) / First Cost',
    description: 'Percentage movement from the first to the latest purchase cost.'
  },
  volatilityPercent: {
    label: 'Volatility %',
    formula: '(Highest Cost - Lowest Cost) / Weighted Average Cost',
    description: 'Price spread measured against the quantity-weighted average purchase cost.'
  },
  coefficientOfVariation: {
    label: 'Coefficient of Variation',
    formula: 'Standard Deviation of Unit Costs / Average Unit Cost',
    description: 'Relative dispersion of observed purchase costs. Higher values indicate less stable pricing.'
  },
  theoreticalUsage: {
    label: 'Theoretical Usage',
    formula: 'Sale Usage + Modifier Usage + Manufacturing Ingredient Consumption',
    description: 'Recipe-driven consumption expected from recorded sales, modifiers, and manufacturing output.'
  },
  expectedClosingStock: {
    label: 'Expected Closing Stock',
    formula: 'Opening + Purchases + Transfers In + Manufacturing In - Theoretical Usage - Wastage - Transfers Out',
    description: 'Calculated closing stock before comparison with the latest committed count or location balance.'
  },
  advancedVarianceQty: {
    label: 'Variance Qty',
    formula: 'Actual Closing Stock - Expected Closing Stock',
    description: 'Positive variance means more stock was counted than expected; negative variance means less.'
  },
  advancedVarianceValue: {
    label: 'Variance Value',
    formula: 'Variance Qty x Unit Cost Ex VAT',
    description: 'Rand value of the calculated quantity variance.'
  },
  advancedVariancePercent: {
    label: 'Variance %',
    formula: 'Variance Qty / Expected Closing Stock',
    description: 'Variance quantity measured against expected closing stock.'
  },
  advancedAccuracyPercent: {
    label: 'Accuracy %',
    formula: '1 - absolute(Variance Qty / Expected Closing Stock)',
    description: 'Clamped comparison accuracy between actual and expected closing stock.'
  },
  varianceImpactScore: {
    label: 'Variance Impact Score',
    formula: 'Weighted variance value, variance %, item value, sales importance, urgency, and data confidence',
    description: 'Prioritises financially material and operationally urgent stock variances.'
  },
  creditNoteVat: {
    label: 'VAT',
    formula: 'Credit Value Incl VAT - Credit Value Ex VAT',
    description: 'VAT portion of the supplier credit.'
  }
};

export default formulaTooltips;
