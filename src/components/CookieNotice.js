export const COOKIE_NOTICE_STORAGE_KEY = 'kcp:cookie-notice:v1';

export function hasAcknowledgedCookieNotice(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(COOKIE_NOTICE_STORAGE_KEY) === 'acknowledged';
  } catch {
    return false;
  }
}

export function acknowledgeCookieNotice(storage = globalThis.localStorage) {
  try {
    storage?.setItem(COOKIE_NOTICE_STORAGE_KEY, 'acknowledged');
    return true;
  } catch {
    return false;
  }
}

export function mountCookieNotice({
  documentRef = globalThis.document,
  storage = globalThis.localStorage
} = {}) {
  if (!documentRef?.body || hasAcknowledgedCookieNotice(storage)) return null;
  const existing = documentRef.getElementById('kcp-cookie-notice');
  if (existing) return existing;

  const notice = documentRef.createElement('aside');
  notice.id = 'kcp-cookie-notice';
  notice.className = 'cookieNotice';
  notice.setAttribute('role', 'status');
  notice.setAttribute('aria-label', 'Cookie and browser storage notice');
  notice.innerHTML = `
    <div class="cookieNotice__copy">
      <strong>Essential cookies only</strong>
      <span>KCP uses secure sign-in and browser storage to keep your session and preferences working.</span>
      <a href="/privacy.html" target="_blank" rel="noopener">Privacy</a>
    </div>
    <button type="button" class="cookieNotice__button">Got it</button>
  `;
  notice.querySelector('.cookieNotice__button')?.addEventListener('click', () => {
    acknowledgeCookieNotice(storage);
    notice.remove();
  });
  documentRef.body.appendChild(notice);
  return notice;
}
