export const salesReportsGroup = {
  id: 'sales_reports',
  title: 'Sales Reports',
  section: 'sales',
  description: 'Sales financials and stock movement from Yoco sales data.',
  type: 'group',
  defaultReportId: 'payment_sales_financial',
  reports: [
    {
      id: 'payment_sales_financial',
      label: 'Payment Summary',
      description: 'Accounting-style sales, VAT, refunds, discounts, tips, fees, and payout values.'
    },
    {
      id: 'sale_stock_movement',
      label: 'Stock Movement',
      description: 'Advanced recipe and inventory usage per menu item sold.'
    }
  ]
};
