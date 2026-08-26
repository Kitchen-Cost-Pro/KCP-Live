import '../styles/customCalendar.css';
import {
  buildCalendarModel,
  formatDisplayDate,
  todayLocal
} from '../utils/date.js';

export function renderCustomCalendarOverlay({
  title = 'Select Date',
  selectedDate,
  cursorDate
} = {}) {
  const calendar = buildCalendarModel(cursorDate, selectedDate);
  return `
    <div class="customCalendar" data-calendar-overlay>
      <div class="customCalendar__card" role="dialog" aria-modal="true">
        <div class="customCalendar__header">
          <div>
            <h3>${escapeHtml(title)}</h3>
            <p>${escapeHtml(formatDisplayDate(selectedDate || todayLocal()))}</p>
          </div>
          <button type="button" class="customCalendar__iconButton" data-calendar-close aria-label="Close calendar">
            ${icon('x')}
          </button>
        </div>

        <div class="customCalendar__nav">
          <div class="customCalendar__navGroup">
            <button type="button" class="customCalendar__iconButton" data-calendar-nav="-12" aria-label="Previous year">${icon('chevronDoubleLeft')}</button>
            <button type="button" class="customCalendar__iconButton" data-calendar-nav="-1" aria-label="Previous month">${icon('chevronLeft')}</button>
          </div>
          <strong>${escapeHtml(calendar.label)}</strong>
          <div class="customCalendar__navGroup">
            <button type="button" class="customCalendar__iconButton" data-calendar-nav="1" aria-label="Next month">${icon('chevronRight')}</button>
            <button type="button" class="customCalendar__iconButton" data-calendar-nav="12" aria-label="Next year">${icon('chevronDoubleRight')}</button>
          </div>
        </div>

        <div class="customCalendar__grid" role="grid">
          ${calendar.weekdays.map((weekday) => `<span class="customCalendar__weekday">${weekday}</span>`).join('')}
          ${calendar.days.map((day) => `
            <button
              type="button"
              class="customCalendar__day ${day.isCurrentMonth ? '' : 'is-outside'} ${day.isToday ? 'is-today' : ''} ${day.isSelected ? 'is-selected' : ''}"
              data-calendar-day="${escapeAttribute(day.date)}"
            >
              ${day.day}
            </button>
          `).join('')}
        </div>

        <div class="customCalendar__footer">
          <span>${escapeHtml(formatDisplayDate(todayLocal()))}</span>
          <button type="button" class="customCalendar__primary" data-calendar-today>Today</button>
        </div>
      </div>
    </div>
  `;
}

export function bindCustomCalendarEvents(root, { onClose, onShift, onSelect, onToday } = {}) {
  root.querySelectorAll('[data-calendar-close]').forEach((button) => {
    button.addEventListener('click', () => onClose?.());
  });

  root.querySelectorAll('[data-calendar-nav]').forEach((button) => {
    button.addEventListener('click', () => onShift?.(Number(button.dataset.calendarNav || 0)));
  });

  root.querySelectorAll('[data-calendar-day]').forEach((button) => {
    button.addEventListener('click', () => onSelect?.(button.dataset.calendarDay || todayLocal()));
  });

  root.querySelector('[data-calendar-today]')?.addEventListener('click', () => onToday?.(todayLocal()));

  root.querySelectorAll('[data-calendar-overlay]').forEach((overlay) => {
    overlay.addEventListener('click', (event) => {
      if (event.target !== overlay) return;
      onClose?.();
    });
  });
}

function icon(name) {
  const icons = {
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronDoubleLeft: '<path d="m17 18-6-6 6-6"/><path d="m11 18-6-6 6-6"/>',
    chevronDoubleRight: '<path d="m7 18 6-6-6-6"/><path d="m13 18 6-6-6-6"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };
  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      ${icons[name] || icons.x}
    </svg>
  `;
}

function escapeHtml(value = '') {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value = '') {
  return escapeHtml(value).replaceAll('`', '&#096;');
}
