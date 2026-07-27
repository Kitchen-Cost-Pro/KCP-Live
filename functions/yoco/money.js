function moneyToMajor(value) {
  if (value && typeof value === 'object') {
    return (Number(value.amount || 0) || 0) / 100;
  }
  return (Number(value || 0) || 0) / 100;
}

function moneyCurrency(value, fallback = 'ZAR') {
  return value && typeof value === 'object' ? value.currency || fallback : fallback;
}

module.exports = {
  moneyCurrency,
  moneyToMajor
};
