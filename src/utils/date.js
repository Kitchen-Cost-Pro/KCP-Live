function pad(value) {
  return String(value).padStart(2, '0');
}

export function formatLocalDateKey(date) {
  const instance = coerceLocalDate(date);
  return `${instance.getFullYear()}-${pad(instance.getMonth() + 1)}-${pad(instance.getDate())}`;
}

export function todayLocal() {
  return formatLocalDateKey(new Date());
}

export function parseLocalDate(value) {
  const raw = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match) {
    return new Date(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      12,
      0,
      0,
      0
    );
  }

  const parsed = new Date(raw || Date.now());
  if (Number.isNaN(parsed.getTime())) {
    const today = new Date();
    return new Date(today.getFullYear(), today.getMonth(), today.getDate(), 12, 0, 0, 0);
  }
  return new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 12, 0, 0, 0);
}

export function startOfMonthKey(value) {
  const current = parseLocalDate(value || todayLocal());
  current.setDate(1);
  return formatLocalDateKey(current);
}

export function shiftMonthKey(value, delta = 0) {
  const current = parseLocalDate(startOfMonthKey(value || todayLocal()));
  current.setMonth(current.getMonth() + Number(delta || 0));
  return formatLocalDateKey(current);
}

export function formatDisplayDate(value) {
  const date = parseLocalDate(value || todayLocal());
  return new Intl.DateTimeFormat('en-ZA', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

export function buildCalendarModel(cursorDate, selectedDate) {
  const cursor = parseLocalDate(startOfMonthKey(cursorDate || todayLocal()));
  const selectedKey = String(selectedDate || todayLocal()).trim() || todayLocal();
  const todayKey = todayLocal();
  const firstDay = new Date(cursor.getFullYear(), cursor.getMonth(), 1, 12, 0, 0, 0);
  const start = new Date(firstDay);
  start.setDate(start.getDate() - ((start.getDay() + 6) % 7));

  const days = [];
  for (let index = 0; index < 42; index += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    const dateKey = formatLocalDateKey(day);
    days.push({
      date: dateKey,
      day: day.getDate(),
      isCurrentMonth: day.getMonth() === cursor.getMonth(),
      isToday: dateKey === todayKey,
      isSelected: dateKey === selectedKey
    });
  }

  return {
    label: new Intl.DateTimeFormat('en-ZA', { month: 'long', year: 'numeric' }).format(cursor),
    weekdays: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'],
    days
  };
}

function coerceLocalDate(value) {
  if (value instanceof Date) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0);
  }
  return parseLocalDate(value);
}
