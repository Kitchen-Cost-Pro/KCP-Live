import { PRIVACY_POLICY_URL } from './legal.js';

const COOKIE_CONSENT_KEY = 'kcp:cookie-consent:v1';

function readConsent() {
  try {
    return localStorage.getItem(COOKIE_CONSENT_KEY);
  } catch {
    return null;
  }
}

function saveConsent(choice) {
  try {
    localStorage.setItem(COOKIE_CONSENT_KEY, JSON.stringify({
      choice,
      savedAt: new Date().toISOString()
    }));
  } catch {
    // Storage may be disabled. The notice can still be dismissed for this visit.
  }
}

export function mountCookieConsent() {
  if (readConsent() || document.querySelector('[data-cookie-consent]')) return;

  const backdrop = document.createElement('div');
  backdrop.className = 'cookieConsent';
  backdrop.dataset.cookieConsent = '';
  backdrop.innerHTML = `
    <section class="cookieConsent__card" role="dialog" aria-modal="true" aria-labelledby="cookie-consent-title">
      <div class="cookieConsent__icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5Z"/>
          <circle cx="8.5" cy="10.5" r=".8" fill="currentColor" stroke="none"/>
          <circle cx="12.5" cy="15.5" r=".8" fill="currentColor" stroke="none"/>
          <circle cx="7.5" cy="16.5" r=".8" fill="currentColor" stroke="none"/>
        </svg>
      </div>
      <p class="cookieConsent__eyebrow">Your privacy</p>
      <h2 id="cookie-consent-title">Cookies on Kitchen Cost Pro</h2>
      <p class="cookieConsent__copy">
        We use essential cookies and local storage to keep you signed in, protect your account and remember your preferences.
        <a href="${PRIVACY_POLICY_URL}#cookies" target="_blank" rel="noopener noreferrer">Read our cookie policy</a>.
      </p>
      <div class="cookieConsent__actions">
        <button type="button" class="cookieConsent__secondary" data-cookie-choice="essential">Essential only</button>
        <button type="button" class="cookieConsent__primary" data-cookie-choice="accepted">Accept</button>
      </div>
    </section>
  `;

  const close = (choice) => {
    saveConsent(choice);
    backdrop.remove();
  };
  backdrop.querySelectorAll('[data-cookie-choice]').forEach((button) => {
    button.addEventListener('click', () => close(button.dataset.cookieChoice || 'essential'));
  });
  document.body.appendChild(backdrop);
  backdrop.querySelector('[data-cookie-choice="accepted"]')?.focus();
}
