import '../styles/scanner.css';

let activeScanner = null;
let isClosing = false;

function createSupportedBarcodeFormats(Html5QrcodeSupportedFormats) {
  if (!Html5QrcodeSupportedFormats) return undefined;
  return [
    'QR_CODE',
    'CODE_39',
    'CODE_93',
    'CODE_128',
    'EAN_13',
    'EAN_8',
    'UPC_A',
    'UPC_E',
    'ITF',
    'CODABAR',
    'DATA_MATRIX',
    'PDF_417'
  ]
    .map((format) => Html5QrcodeSupportedFormats[format])
    .filter((format) => typeof format === 'number');
}

async function createScannerSession({
  elementId,
  continuous = false,
  continuousIntervalMs = 1000,
  useQrbox = true,
  onScan,
  onStatus,
  onError
} = {}) {
  const lastScanAtByCode = new Map();
  const host = document.getElementById(elementId);
  if (!host) {
    const error = new Error('Scanner container is not available yet.');
    onError?.(error);
    return null;
  }

  try {
    const { Html5Qrcode, Html5QrcodeSupportedFormats } = await import('html5-qrcode');
    const formatsToSupport = createSupportedBarcodeFormats(Html5QrcodeSupportedFormats);
    activeScanner = new Html5Qrcode(
      elementId,
      formatsToSupport?.length ? { formatsToSupport } : undefined
    );

    const qrbox = Math.min(Math.round((host?.clientWidth || 320) * 0.72), 280);
    const config = useQrbox
      ? { fps: 10, qrbox: { width: qrbox, height: qrbox } }
      : { fps: 10 };
    const onSuccess = (decodedText) => {
      if (isClosing) return;
      const value = String(decodedText || '').trim();
      if (!value) return;
      onStatus?.(`Detected ${value}`);
      const shouldBeep = (result) => {
        if (result === false) return false;
        if (result && typeof result === 'object' && 'beep' in result) {
          return result.beep !== false;
        }
        return true;
      };
      if (continuous) {
        const now = Date.now();
        const lastScanAt = lastScanAtByCode.get(value) || 0;
        if ((now - lastScanAt) < Math.max(Number(continuousIntervalMs || 1000), 250)) {
          return;
        }
        lastScanAtByCode.set(value, now);
        const accepted = onScan?.(value, { continuous: true });
        if (shouldBeep(accepted)) {
          beep();
        }
        onStatus?.(`Counted ${value} (+1)`);
        return;
      }
      const accepted = onScan?.(value, { continuous: false });
      if (shouldBeep(accepted)) {
        beep();
      }
    };
    const onFailure = () => {
      if (!isClosing) onStatus?.('Scanning...');
    };

    let startError = null;
    try {
      await activeScanner.start({ facingMode: { exact: 'environment' } }, config, onSuccess, onFailure);
    } catch (error) {
      startError = error;
      try {
        await activeScanner.start({ facingMode: 'environment' }, config, onSuccess, onFailure);
      } catch (fallbackError) {
        startError = fallbackError;
        try {
          await activeScanner.start({ facingMode: 'user' }, config, onSuccess, onFailure);
        } catch (userFacingError) {
          startError = userFacingError;
          const scanner = activeScanner;
          activeScanner = null;
          try {
            scanner?.clear();
          } catch {
            // Scanner may not have reached a clearable state.
          }
          throw startError;
        }
      }
    }
    return async () => {
      if (!activeScanner) return;
      const scanner = activeScanner;
      activeScanner = null;
      isClosing = true;
      await scanner.stop().catch(() => {});
      try {
        scanner.clear();
      } catch {
        // ignore clear failures
      } finally {
        isClosing = false;
      }
    };
  } catch (error) {
    activeScanner = null;
    onError?.(error);
    return null;
  }
}

export async function openBarcodeScanner({
  title = 'Scan Barcode',
  helper = 'Point your camera at a barcode.',
  onScan,
  continuous = false,
  continuousIntervalMs = 1000,
  useQrbox = true
} = {}) {
  closeBarcodeScanner();
  isClosing = false;

  const root = document.createElement('div');
  root.className = 'barcodeScanner';
  root.innerHTML = `
    <section class="barcodeScanner__modal" role="dialog" aria-modal="true" aria-labelledby="barcode-scanner-title">
      <header class="barcodeScanner__header">
        <div>
          <p>Photo Scanner</p>
          <h2 id="barcode-scanner-title">${escapeHtml(title)}</h2>
          <span>${escapeHtml(helper)}</span>
        </div>
        <button type="button" class="barcodeScanner__close" data-scanner-close aria-label="Close scanner">${icon('x')}</button>
      </header>
      <div class="barcodeScanner__viewport">
        <div id="barcode-scanner-reader" class="barcodeScanner__reader"></div>
        <div class="barcodeScanner__reticle" aria-hidden="true"></div>
        <div class="barcodeScanner__status" data-scanner-status>Starting camera...</div>
      </div>
      <form class="barcodeScanner__manual" data-scanner-form>
        <label>
          <span>Manual Barcode</span>
          <input type="text" inputmode="numeric" autocomplete="off" placeholder="Type or paste barcode..." data-scanner-manual />
        </label>
        <button type="submit">Use Code</button>
      </form>
    </section>
  `;

  document.body.appendChild(root);
  const reader = root.querySelector('#barcode-scanner-reader');
  const status = root.querySelector('[data-scanner-status]');
  const manualInput = root.querySelector('[data-scanner-manual]');

  const finish = (code, { closeAfter = !continuous } = {}) => {
    const value = String(code || '').trim();
    if (!value) return;
    onScan?.(value);
    if (closeAfter) {
      closeBarcodeScanner();
      return;
    }
    if (manualInput) manualInput.value = '';
  };

  root.querySelector('[data-scanner-close]')?.addEventListener('click', closeBarcodeScanner);
  root.addEventListener('click', (event) => {
    if (event.target === root) closeBarcodeScanner();
  });
  root.querySelector('[data-scanner-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    finish(manualInput?.value, { closeAfter: !continuous });
  });

  const stopScanner = await createScannerSession({
    elementId: 'barcode-scanner-reader',
    continuous,
    continuousIntervalMs,
    useQrbox,
    onScan: (value, { continuous: isContinuous } = {}) => {
      finish(value, { closeAfter: !isContinuous });
    },
    onStatus: (message) => {
      if (status) status.textContent = message;
    },
    onError: (error) => {
      console.warn('[Scanner] Camera scanner failed:', error);
    }
  });

  if (!activeScanner) {
    status.textContent = 'Camera permission denied or unavailable. Enter the barcode below.';
    manualInput?.focus({ preventScroll: true });
  }

  return stopScanner || (async () => {});
}

export async function mountBarcodeScanner({
  elementId,
  continuous = false,
  continuousIntervalMs = 1000,
  useQrbox = true,
  onScan,
  onStatus,
  onError
} = {}) {
  closeBarcodeScanner();
  isClosing = false;
  return createScannerSession({
    elementId,
    continuous,
    continuousIntervalMs,
    useQrbox,
    onScan,
    onStatus,
    onError
  });
}

export function closeBarcodeScanner() {
  isClosing = true;
  if (activeScanner) {
    const scanner = activeScanner;
    activeScanner = null;
    scanner.stop()
      .catch(() => {})
      .finally(() => {
        try {
          scanner.clear();
        } catch {
          // Scanner may already be cleared after a failed start.
        }
      });
  }

  document.querySelectorAll('.barcodeScanner').forEach((node) => node.remove());
}

function beep() {
  try {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.frequency.value = 880;
    gain.gain.value = 0.035;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.08);
  } catch {
    // Audio feedback is nice to have, not required.
  }
}

function icon(name) {
  const icons = {
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'
  };

  return `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
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
