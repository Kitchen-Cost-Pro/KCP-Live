import { safeNumber } from './calculations.js';
import { parseUtcDate } from './forecasting.js';

export function buildDailySeries(rows = [], { dateSelector = (row) => row.date, valueSelector = (row) => row.value, from = '', to = '' } = {}) {
  const totals = new Map();
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const date = String(dateSelector(row) || '').slice(0, 10);
    if (!date) return;
    totals.set(date, (totals.get(date) || 0) + safeNumber(valueSelector(row)));
  });
  const start = parseUtcDate(from || [...totals.keys()].sort()[0]);
  const end = parseUtcDate(to || [...totals.keys()].sort().pop());
  if (!start || !end) return [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, value]) => ({ date, value }));
  const series = [];
  const cursor = new Date(start.getTime());
  while (cursor <= end) {
    const date = cursor.toISOString().slice(0, 10);
    series.push({ date, value: totals.get(date) || 0 });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return series;
}

export function calculateTrendSlope(values = []) {
  const numbers = (Array.isArray(values) ? values : []).map((value) => safeNumber(value));
  if (numbers.length < 2) return 0;
  const n = numbers.length;
  const meanX = (n - 1) / 2;
  const meanY = numbers.reduce((sum, value) => sum + value, 0) / n;
  let numerator = 0;
  let denominator = 0;
  numbers.forEach((value, index) => {
    numerator += (index - meanX) * (value - meanY);
    denominator += (index - meanX) ** 2;
  });
  return denominator ? numerator / denominator : 0;
}

export function calculateTrendDirection(values = [], tolerance = 0.01) {
  const slope = calculateTrendSlope(values);
  if (slope > tolerance) return 'Increasing';
  if (slope < -tolerance) return 'Decreasing';
  return 'Stable';
}

export function runningAverage(values = []) {
  let total = 0;
  return (Array.isArray(values) ? values : []).map((value, index) => {
    total += safeNumber(value);
    return total / (index + 1);
  });
}
