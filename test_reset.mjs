function getTimestamp(value) {
  if (!value) return 0;
  if (typeof value === 'number') return value < 10000000000 ? value * 1000 : value;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return isNaN(parsed) ? 0 : parsed;
  }
  return value.getTime ? value.getTime() : 0;
}

const resetAtStr = '2026-07-08T19:08:43+02:00';
const resetAt = getTimestamp(resetAtStr);

const postNow = '2026-07-08T19:10:00+02:00'; // posted without UI date
const postPast = '2026-07-08T00:00:00.000Z'; // posted WITH UI date "Today"

console.log("resetAt:", resetAt, new Date(resetAt).toISOString());
console.log("postNow:", getTimestamp(postNow), getTimestamp(postNow) >= resetAt);
console.log("postPast:", getTimestamp(postPast), getTimestamp(postPast) >= resetAt);
