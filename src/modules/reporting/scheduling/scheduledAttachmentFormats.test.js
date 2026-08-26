import test from 'node:test';
import assert from 'node:assert/strict';
import { reportToExcelBytes } from '../exports/exportExcel.js';
import { reportToPdfBytes } from '../exports/exportPdf.js';
import { emailAttachmentBytes, encodeEmailAttachmentBase64 } from './emailAttachmentEncoding.js';

const reportResult = {
  id: 'payment_sales_financial',
  title: 'Payment / Sales Financial Report',
  report: {
    id: 'payment_sales_financial',
    title: 'Payment / Sales Financial Report',
    defaultView: 'transaction_detail'
  },
  view: 'transaction_detail',
  generatedAt: '2026-07-10T16:40:00.000Z',
  filters: { from: '2026-07-10', to: '2026-07-10', locationId: 'loc_downstairs' },
  meta: { timezone: 'Africa/Johannesburg' },
  columns: [
    { key: 'saleDate', label: 'Date', type: 'date' },
    { key: 'saleTime', label: 'Time', type: 'time' },
    { key: 'receiptNumber', label: 'Receipt Number' },
    { key: 'locationName', label: 'Location' },
    { key: 'grossAmount', label: 'Gross Amount', type: 'money' },
    { key: 'vatAmount', label: 'VAT', type: 'money' },
    { key: 'netAmount', label: 'Net Amount', type: 'money' }
  ],
  rows: [
    {
      saleDate: '2026-07-10',
      saleTime: '18:38',
      receiptNumber: 'order-001',
      locationName: 'Downstairs Bar',
      grossAmount: 560,
      vatAmount: 73.04,
      netAmount: 486.96
    }
  ],
  totals: { grossAmount: 560, vatAmount: 73.04, netAmount: 486.96 },
  warnings: []
};

function assertBinaryRoundTrip(bytes) {
  const encoded = encodeEmailAttachmentBase64(bytes);
  const decoded = new Uint8Array(Buffer.from(encoded, 'base64'));
  assert.deepEqual(decoded, emailAttachmentBytes(bytes));
}

test('scheduled XLSX attachments are valid binary Office Open XML files and survive email base64 encoding', async () => {
  const bytes = await reportToExcelBytes(reportResult, { formatted: true });
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.byteLength > 1000);
  assert.deepEqual([...bytes.slice(0, 4)], [0x50, 0x4b, 0x03, 0x04]);
  assertBinaryRoundTrip(bytes);
});

test('scheduled PDF attachments are valid binary PDF files and survive email base64 encoding', async () => {
  const bytes = await reportToPdfBytes(reportResult, { formatted: true });
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.byteLength > 1000);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), '%PDF-');
  assertBinaryRoundTrip(bytes);
});

test('text and typed-array email attachments use one binary-safe encoder', () => {
  assert.equal(Buffer.from(encodeEmailAttachmentBase64('Kitchen Cost Pro'), 'base64').toString('utf8'), 'Kitchen Cost Pro');
  const source = new Uint16Array([0, 255, 256, 65535]);
  const decoded = new Uint8Array(Buffer.from(encodeEmailAttachmentBase64(source), 'base64'));
  assert.deepEqual(decoded, new Uint8Array(source.buffer));
});
