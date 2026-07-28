import { escapeHtml, formatCell } from '../engine/formatters.js';
import { text, toArray } from '../engine/grouping.js';
import { isTransactionIdColumn } from '../transactions/transactionColumnVisibility.js';

export function renderReportTotalsRow(columns = [], totals = {}) {
  const cols = toArray(columns);
  if (!cols.length || !totals || !Object.keys(totals).length) return '';
  return `
    <tfoot>
      <tr>
        ${cols.map((column, index) => {
          const value = index === 0 ? 'Totals' : totals[column.key];
          const alignValue = resolveColumnAlign(column);
          const align = alignValue ? ` style="text-align:${escapeHtml(alignValue)}"` : '';
          const classes = ['reportTable__cell', isNumericColumn(column) ? 'is-numeric' : '', column.key === 'sourceId' ? 'is-source-id' : '', isTransactionIdColumn(column) ? 'reportTable__transactionColumn' : ''].filter(Boolean).join(' ');
          return `<td class="${escapeHtml(classes)}" data-column-key="${escapeHtml(column.key || '')}"${align}>${escapeHtml(index === 0 ? value : formatCell(value, column))}</td>`;
        }).join('')}
      </tr>
    </tfoot>
  `;
}

function resolveColumnAlign(column = {}) {
  if (isNumericColumn(column)) return 'center';
  if (column.align) return column.align;
  return 'left';
}

function isNumericColumn(column = {}) {
  return ['money', 'number', 'percent', 'qty', 'quantity'].includes(text(column.type).toLowerCase());
}
