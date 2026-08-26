// Guided first-run setup wizard. Sequences KCP's EXISTING bulk-import tools (Suppliers, Stock
// Items, Recipes) and the Yoco POS connect/sync flow into one guided flow for a brand-new
// workspace — it introduces no new import/sync logic of its own, only sequencing/UX glue. See
// memory/plan: no POS integration can ever supply supplier/recipe/cost data, so this is purely
// about making the tools that already exist easy to find and use in the right order.
//
// Mirrors the multi-step wizard pattern already used by PurchaseOrders.js (getWizardStep,
// isWizardStepLocked, renderWizardSteps, renderWizardFooter) rather than inventing a new one.
//
// Uses daisyUI (modal/steps/btn/badge/alert), themed via a custom "kcp" daisyUI theme (see
// src/styles/tailwind.css) that maps straight onto this app's own CSS variables, so it follows
// the app's real accent colors and light/dark toggle rather than a generic daisyUI palette.

const ONBOARDING_STEPS = [1, 2, 3, 4];

// Which "pane" is currently showing, independent of the step number — used to decide how the
// next pane should enter (see getPaneEnterClass below). Module-level rather than on the onboarding
// state object since it's pure animation bookkeeping, not app state that needs to persist/reload.
let lastPaneSignature = null;

function computePaneSignature(onboarding, wizardStep) {
  if (onboarding.welcome) return 'welcome';
  if (onboarding.pendingImport) return `preview:${onboarding.pendingImport.kind}`;
  if (onboarding.quickAdd) return `quickadd:${onboarding.quickAdd.kind}`;
  if (onboarding.recipeBuilder) return 'recipebuilder';
  return `step:${wizardStep}`;
}

// Next/Back should feel like moving through the wizard (slide right/left); everything else
// (welcome -> step 1, opening a quick-add form, a busy-state re-render on the SAME pane) just
// fades in — sliding sideways for those would read as motion that isn't actually going anywhere.
// Returns null for a same-signature re-render (e.g. actionStatus flipping busy/idle) so those
// don't replay the entrance animation on every keystroke-unrelated render.
function getPaneEnterClass(signature) {
  const previous = lastPaneSignature;
  lastPaneSignature = signature;
  if (previous === signature) return null;
  if (previous) {
    const prevStep = previous.startsWith('step:') ? Number(previous.slice(5)) : null;
    const nextStep = signature.startsWith('step:') ? Number(signature.slice(5)) : null;
    if (prevStep !== null && nextStep !== null) return nextStep > prevStep ? 'kcp-pane-forward' : 'kcp-pane-backward';
  }
  return 'kcp-pane-fade';
}

const STEPS = [
  { value: 1, label: 'Connect POS' },
  { value: 2, label: 'Suppliers' },
  { value: 3, label: 'Stock Items' },
  { value: 4, label: 'Recipes' },
  { value: 5, label: 'Finish' }
];

// The real "KCP" wordmark, not hand-drawn letterforms — this is just the same bold text the app's
// own logo mark uses (see .logoMark in auth.module.css: font-weight 900, no custom typeface),
// so it always matches whatever font the rest of the app is using, in the right weight/spacing.
// "Drawn left to right" is done as a wipe reveal (an animated clip-path) rather than literal
// pen-stroke tracing, since real glyphs don't decompose into strokes to dash-animate. Plays once
// on mount rather than looping — a welcome flourish, not a spinner.
function renderOnboardingWordmark() {
  return `
    <div class="text-6xl font-black tracking-tight text-primary" style="clip-path: inset(0 100% 0 0); animation: kcp-wordmark-reveal 0.9s ease forwards;">
      <style>
        @keyframes kcp-wordmark-reveal { to { clip-path: inset(0 0% 0 0); } }
      </style>
      KCP
    </div>
  `;
}

// Shown once, before step 1, on every fresh open (auto-open on login or "Relaunch Setup Wizard"
// from Settings), not on resume-from-minimized, since `welcome` stays false once already
// dismissed. Purely a friendly intro; "Let's Get Started" just flips onboarding.welcome to false.
export function renderOnboardingWelcomePane() {
  return `
    <section class="flex flex-col items-center text-center gap-4 py-6">
      ${renderOnboardingWordmark()}
      <h3 class="text-xl font-semibold">Welcome to KCP 👋</h3>
      <p class="text-sm opacity-80 max-w-md">
        Let's get your workspace ready to go live. We'll connect your Yoco POS, bring in your
        suppliers and stock items, and make sure every product has a recipe, all in a few quick
        steps, right here.
      </p>
      <button type="button" class="btn btn-primary btn-wide mt-2" data-onboarding-start>Let's Get Started</button>
    </section>
  `;
}

export function getWizardStep(onboarding = {}) {
  const step = Number(onboarding.wizardStep || 1);
  return Math.min(5, Math.max(1, step));
}

// Every onboarding action (Yoco connect, supplier/stock/recipe quick-add) now happens inline,
// in-modal — nothing here navigates away via appState.route any more. This resume pill is kept
// for the one remaining case where the wizard still minimizes itself: the "Add another ingredient"
// style flows never route away, so in practice this is now unused unless a future step adds a
// real navigate-away action — left in place rather than removed since it's harmless dead code
// that documents the minimize mechanism.
export function renderOnboardingResumeButton() {
  return `
    <button type="button" class="btn btn-primary rounded-full shadow-lg fixed bottom-6 right-6 z-50" data-onboarding-resume>
      Resume Setup
    </button>
  `;
}

export function bindOnboardingResumeButtonEvents(el, onOnboardingAction = {}) {
  el.addEventListener('click', () => onOnboardingAction.onResume?.());
}

// A step's REAL completion, independent of which step is currently on screen — drives both the
// checkmarks in the steps nav and the "N of 4 completed" progress text (here and in Settings'
// Go-Live panel), and lets Next skip past steps that are already done (see main.js's
// onboardingGoNext). Step 5 (Finish) is a destination, not something with its own completion.
export function isOnboardingStepComplete(step, onboarding = {}) {
  const counts = onboarding.counts;
  if (step === 1) return onboarding.yoco?.connectionActive === true;
  if (step === 2) return Number(counts?.supplierCount || 0) > 0;
  if (step === 3) return Number(counts?.stockItemCount || 0) > 0;
  if (step === 4) return Number(counts?.productCount || 0) > 0 && Number(counts?.missingRecipeCount || 0) === 0;
  return false;
}

export function firstIncompleteOnboardingStep(onboarding = {}) {
  for (const step of ONBOARDING_STEPS) {
    if (!isOnboardingStepComplete(step, onboarding)) return step;
  }
  return 5;
}

export function getOnboardingProgress(onboarding = {}) {
  const completed = ONBOARDING_STEPS.filter((step) => isOnboardingStepComplete(step, onboarding)).length;
  return { completed, total: ONBOARDING_STEPS.length };
}

// Split into a SHELL (the .modal/.modal-box wrapper — created exactly once while the wizard is
// open) and CONTENT (steps/pane/footer — re-rendered on every step change or action-status
// update). daisyUI's modal-open transition animates in on every element it's first applied to; if
// the whole modal were torn down and rebuilt on every Next/Back click (as it originally was —
// same DOM-replace pattern as mountImportNotificationModal, which is fine for a modal shown once
// but not for one that re-renders on internal navigation), that transition replayed every single
// click and looked like the modal flickering closed then open. Keeping the shell's DOM node alive
// across internal re-renders and only patching its content in place avoids that entirely.
export function renderOnboardingWizardShell() {
  return `
    <div class="modal modal-open" data-onboarding-backdrop>
      <div class="modal-box max-w-2xl bg-base-100 text-base-content relative overflow-x-hidden overflow-y-auto" role="dialog" aria-modal="true" aria-labelledby="onboarding-wizard-title" tabindex="-1">
        <style>
          @keyframes kcp-pane-fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
          @keyframes kcp-pane-forward { from { opacity: 0; transform: translateX(24px); } to { opacity: 1; transform: translateX(0); } }
          @keyframes kcp-pane-backward { from { opacity: 0; transform: translateX(-24px); } to { opacity: 1; transform: translateX(0); } }
          .kcp-pane-fade { animation: kcp-pane-fade 0.22s ease-out; }
          .kcp-pane-forward { animation: kcp-pane-forward 0.26s ease-out; }
          .kcp-pane-backward { animation: kcp-pane-backward 0.26s ease-out; }
        </style>
        <div class="pointer-events-none absolute inset-0" style="background: radial-gradient(circle at 15% -10%, var(--color-primary) 0%, transparent 60%), radial-gradient(circle at 105% 110%, var(--color-primary) 0%, transparent 55%); opacity: 0.16; filter: blur(40px);"></div>

        <div class="relative flex items-start justify-between gap-4 mb-2">
          <div>
            <p class="text-xs uppercase tracking-wide opacity-60 mb-1">Setup</p>
            <h2 id="onboarding-wizard-title" class="text-lg font-semibold">Get your workspace ready</h2>
          </div>
          <button type="button" class="btn btn-sm btn-circle btn-ghost" data-onboarding-dismiss aria-label="Close setup wizard">✕</button>
        </div>

        <p class="relative text-xs opacity-60" data-onboarding-progress></p>

        <div class="relative" data-onboarding-toast></div>

        <ul class="relative steps steps-horizontal w-full my-6" data-onboarding-steps></ul>

        <div class="relative" data-onboarding-error></div>

        <div class="relative py-2" data-onboarding-pane></div>

        <div class="relative" data-onboarding-footer></div>
      </div>
    </div>
  `;
}

function renderStepsMarkup(wizardStep, onboarding) {
  return STEPS.map((step) => {
    const complete = step.value < 5 && isOnboardingStepComplete(step.value, onboarding);
    // daisyUI's .step already numbers the circle itself via a CSS counter; the li's own text
    // content is the label shown underneath. Putting step.value in there too (as before) rendered
    // the number twice. data-content overrides the circle's content, so it's the only way to swap
    // in a checkmark once a step is complete.
    const dataContent = complete ? ` data-content="✓"` : '';
    return `
      <li class="step ${step.value <= wizardStep ? 'step-primary' : ''} cursor-pointer" data-onboarding-step="${step.value}"${dataContent}>
        ${escapeHtml(step.label)}
      </li>
    `;
  }).join('');
}

// Patches the shell's content regions in place and (re)binds events on just those regions —
// called on every render while the wizard is open, without touching the shell nodes themselves.
export function updateOnboardingWizardContent(container, onboarding, onOnboardingAction = {}) {
  const wizardStep = getWizardStep(onboarding);
  const counts = onboarding.counts || null;
  const yoco = onboarding.yoco || null;
  const pendingImport = onboarding.pendingImport || null;

  const progressEl = container.querySelector('[data-onboarding-progress]');
  if (progressEl) {
    if (onboarding.welcome) {
      progressEl.textContent = '';
    } else {
      const { completed, total } = getOnboardingProgress(onboarding);
      progressEl.textContent = `${completed} of ${total} steps completed`;
    }
  }

  const stepsEl = container.querySelector('[data-onboarding-steps]');
  if (stepsEl) {
    stepsEl.innerHTML = onboarding.welcome ? '' : renderStepsMarkup(wizardStep, onboarding);
    stepsEl.querySelectorAll('[data-onboarding-step]').forEach((el) => {
      el.addEventListener('click', () => onOnboardingAction.onStepChange?.(Number(el.dataset.onboardingStep || 1) || 1));
    });
  }

  if (onboarding.welcome) {
    const paneEl = container.querySelector('[data-onboarding-pane]');
    if (paneEl) {
      paneEl.innerHTML = renderOnboardingWelcomePane();
      paneEl.querySelector('[data-onboarding-start]')?.addEventListener('click', () => onOnboardingAction.onStartWizard?.());
      const enterClass = getPaneEnterClass(computePaneSignature(onboarding, wizardStep));
      if (enterClass) paneEl.firstElementChild?.classList.add(enterClass);
    }
    const footerEl = container.querySelector('[data-onboarding-footer]');
    if (footerEl) footerEl.innerHTML = '';
    const errorEl = container.querySelector('[data-onboarding-error]');
    if (errorEl) errorEl.innerHTML = '';
    return;
  }

  const errorEl = container.querySelector('[data-onboarding-error]');
  if (errorEl) {
    errorEl.innerHTML = onboarding.actionError
      ? `<div class="alert alert-error mb-4"><span>${escapeHtml(onboarding.actionError)}</span></div>`
      : '';
  }

  const toastEl = container.querySelector('[data-onboarding-toast]');
  if (toastEl) {
    toastEl.innerHTML = onboarding.toast
      ? `<div class="alert ${onboarding.toast.type === 'error' ? 'alert-error' : 'alert-success'} mb-2 py-2 text-sm"><span>${escapeHtml(onboarding.toast.message)}</span></div>`
      : '';
  }

  const paneEl = container.querySelector('[data-onboarding-pane]');
  if (paneEl) {
    paneEl.innerHTML = renderWizardPane(wizardStep, {
      counts,
      yoco,
      actionStatus: onboarding.actionStatus || '',
      actionNote: onboarding.actionNote || '',
      pendingImport,
      quickAdd: onboarding.quickAdd || null,
      recipeBuilder: onboarding.recipeBuilder || null,
      aiOnboardingEnabled: onboarding.aiOnboardingEnabled === true
    });
    bindPaneEvents(paneEl, onOnboardingAction);
    const enterClass = getPaneEnterClass(computePaneSignature(onboarding, wizardStep));
    if (enterClass) paneEl.firstElementChild?.classList.add(enterClass);
  }

  const footerEl = container.querySelector('[data-onboarding-footer]');
  if (footerEl) {
    footerEl.innerHTML = renderWizardFooter(wizardStep, onboarding);
    bindFooterEvents(footerEl, onOnboardingAction);
  }
}

function renderWizardPane(wizardStep, context) {
  if (wizardStep === 1) return renderConnectStep(context);
  if (wizardStep === 2) return renderImportStep(context, {
    kind: 'suppliers',
    title: 'Import your suppliers',
    description: 'Bring in supplier contacts, payment terms, and account details. Yoco has no concept of suppliers, so this always starts as a bulk import or manual entry.',
    countLabel: (count) => `${count} supplier${count === 1 ? '' : 's'} on file`,
    count: context.counts?.supplierCount ?? null,
    inputAttr: 'data-onboarding-import-suppliers',
    accept: '.csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv',
    downloadTemplateAttr: 'data-onboarding-download-supplier-template',
    addManuallyAttr: 'data-onboarding-add-supplier-manually',
    aiInputAttr: 'data-onboarding-scan-suppliers',
    aiHint: 'Upload a photo of a supplier list, invoice letterhead, or business cards'
  });
  if (wizardStep === 3) return renderImportStep(context, {
    kind: 'stock',
    title: 'Import your stock items',
    description: 'Raw ingredients, costs, and units of measure. Recipes in the next step can only reference ingredients that already exist here.',
    countLabel: (count) => `${count} stock item${count === 1 ? '' : 's'} on file`,
    count: context.counts?.stockItemCount ?? null,
    inputAttr: 'data-onboarding-import-stock',
    accept: '.csv,.json,.xlsx,.xls,text/csv,application/json',
    downloadTemplateAttr: 'data-onboarding-download-stock-template',
    addManuallyAttr: 'data-onboarding-add-stock-manually',
    aiInputAttr: 'data-onboarding-scan-stock',
    aiHint: 'Upload a photo of a stock sheet or price list'
  });
  if (wizardStep === 4) return renderRecipesStep(context);
  return renderFinishStep(context);
}

function renderConnectStep({ yoco, actionStatus }) {
  const connected = yoco?.connectionActive === true;
  const lastSync = yoco?.lastSyncCompletedAt ? formatRelativeTimestamp(yoco.lastSyncCompletedAt) : '';
  const connecting = actionStatus === 'connecting';
  return `
    <section class="flex flex-col gap-4">
      <h3 class="font-semibold text-base">Connect your Yoco POS</h3>
      <p class="text-sm opacity-80">Syncing your Yoco catalogue brings in your menu (product names, prices, and categories) automatically. Yoco has no visibility into cost, ingredients, or suppliers, so those still come from the next few steps.</p>
      <div class="alert ${connected ? 'alert-success' : 'alert-warning'}">
        <span>
          <strong>${connected ? 'Connected' : 'Not connected yet'}</strong>:
          ${connected ? (lastSync ? `Last synced ${lastSync}` : 'Connected, sync to pull in your menu.') : 'Enter your Yoco API key below to connect.'}
        </span>
      </div>
      ${connected
        ? `<div class="flex gap-2">
            <button type="button" class="btn btn-primary" data-onboarding-sync-now ${actionStatus === 'syncing' ? 'disabled' : ''}>${actionStatus === 'syncing' ? 'Syncing…' : 'Sync Now'}</button>
          </div>`
        : `<form class="flex flex-wrap gap-2 items-start" data-onboarding-connect-yoco-form>
            <input type="text" name="apiKey" class="input input-bordered flex-1 min-w-[16rem]" placeholder="Yoco API key" autocomplete="off" ${connecting ? 'disabled' : ''} />
            <button type="submit" class="btn btn-primary" ${connecting ? 'disabled' : ''}>${connecting ? 'Connecting…' : 'Connect'}</button>
          </form>`}
    </section>
  `;
}

// Feature 2: preview-before-commit. Selecting a file no longer imports immediately — it's parsed
// and validated first (reusing the exact same mapping functions the real import already uses), and
// shown here as "N ready, M will be skipped" before the user confirms. This surfaces row-level
// problems (a blank required column, an unmatched ingredient name) before anything is written,
// instead of only finding out after the import notification pops up.
// Column set per kind for the AI-scan "here's what we found" table — deliberately just the
// fields a person would actually glance at to sanity-check an extraction, not every field the
// real import row carries (e.g. supplier Payment_Terms/Account_Number aren't shown here, but
// they DO still get imported — this table is a review aid, not the full record).
//
// `key` is the field name on the underlying row object (suppliers/stock rows ARE the actual
// import payload — see onboardingScanWithAi in main.js — so editing here edits what gets
// imported, no separate sync step needed). `alwaysOpen` columns (Category) render as a plain
// text input at all times rather than only while the row is in edit mode: AI's category guess is
// exactly the kind of thing that needs a human decision for reporting to be trustworthy, so it
// shouldn't take an extra click to override. Recipes rows have no `key`s — their "ingredients"
// column is a derived display string, not a single editable field — so they get delete but not
// inline field editing; correcting a wrong recipe extraction means deleting it and using the
// per-ingredient recipe builder or bulk template instead.
const EXTRACTED_ROW_COLUMNS = {
  suppliers: [
    { label: 'Name', key: 'Name' },
    { label: 'Contact Person', key: 'Contact_Person' },
    { label: 'Email', key: 'Email' },
    { label: 'Phone', key: 'Phone' },
    { label: 'Category', key: 'Category', alwaysOpen: true },
    { label: 'Review', get: (r) => (r._dupWarning ? `⚠️ ${r._dupWarning}` : '') }
  ],
  stock: [
    { label: 'Name', key: 'name' },
    { label: 'Category', key: 'category', alwaysOpen: true },
    { label: 'Base UOM', key: 'unit' },
    {
      label: 'Pack Size',
      get: (r) => (r.uomConfigurations || []).map((cfg) => `${cfg.customUom} = ${cfg.ratio} ${r.unit}`).join(', ')
    },
    { label: 'Notes', key: 'notes' },
    { label: 'Review', get: (r) => (r._dupWarning ? `⚠️ ${r._dupWarning}` : '') }
  ],
  recipes: [
    { label: 'Product', get: (r) => r.name },
    { label: 'Category', get: (r) => r.category },
    { label: 'Ingredients', get: (r) => r.ingredientsText }
  ]
};

function renderExtractedRowsTable(kind, rows, editingIndex) {
  const columns = EXTRACTED_ROW_COLUMNS[kind];
  if (!columns || !rows?.length) return '';
  const editable = columns.some((col) => col.key);
  return `
    <div class="max-h-64 overflow-y-auto border border-base-200 rounded-box">
      <table class="table table-xs table-pin-rows">
        <thead>
          <tr>
            ${columns.map((col) => `<th>${escapeHtml(col.label)}</th>`).join('')}
            ${editable ? '<th class="text-right"><span class="sr-only">Actions</span></th>' : ''}
          </tr>
        </thead>
        <tbody>
          ${rows.map((row, index) => {
            const isEditing = index === editingIndex;
            return `
            <tr>
              ${columns.map((col) => {
                const value = col.get ? col.get(row) : row[col.key];
                const showInput = col.key && (col.alwaysOpen || isEditing);
                if (!showInput) return `<td>${escapeHtml(value || '—')}</td>`;
                return `<td><input type="text" class="input input-bordered input-xs w-full" value="${escapeAttribute(value || '')}" data-onboarding-preview-field data-row-index="${index}" data-field-key="${escapeAttribute(col.key)}" /></td>`;
              }).join('')}
              ${editable ? `
                <td class="text-right whitespace-nowrap">
                  ${isEditing
                    ? `<button type="button" class="btn btn-ghost btn-xs" data-onboarding-preview-save data-row-index="${index}" title="Save">✔️</button>
                       <button type="button" class="btn btn-ghost btn-xs" data-onboarding-preview-cancel-edit title="Cancel">✕</button>`
                    : `<button type="button" class="btn btn-ghost btn-xs" data-onboarding-preview-edit data-row-index="${index}" title="Edit">✏️</button>`}
                  <button type="button" class="btn btn-ghost btn-xs" data-onboarding-preview-delete data-row-index="${index}" title="Remove">🗑️</button>
                </td>
              ` : ''}
            </tr>
          `;
          }).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderImportPreviewPanel(pendingImport, actionStatus) {
  const busy = actionStatus === 'importing';
  const hasIssues = pendingImport.skippedCount > 0;
  const isAi = pendingImport.source === 'ai';
  return `
    <section class="flex flex-col gap-4">
      <h3 class="font-semibold text-base">Review before importing</h3>
      <p class="text-sm opacity-80">${escapeHtml(pendingImport.fileName)}</p>
      <div class="flex flex-wrap gap-2">
        <div class="badge badge-success">${pendingImport.readyCount} row${pendingImport.readyCount === 1 ? '' : 's'} ready</div>
        ${hasIssues ? `<div class="badge badge-warning">${pendingImport.skippedCount} row${pendingImport.skippedCount === 1 ? '' : 's'} will be skipped</div>` : ''}
      </div>
      ${isAi && pendingImport.rows?.length ? `
        <div>
          <p class="text-xs uppercase tracking-wide opacity-60 mb-1">${escapeHtml(pendingImport.kind === 'suppliers' ? 'Suppliers found' : pendingImport.kind === 'stock' ? 'Stock items found' : 'Recipes found')}</p>
          ${renderExtractedRowsTable(pendingImport.kind, pendingImport.rows, pendingImport.editingIndex ?? -1)}
        </div>
      ` : ''}
      ${hasIssues && pendingImport.errorSummary ? `<div class="alert alert-warning text-sm"><span>${escapeHtml(pendingImport.errorSummary)}</span></div>` : ''}
      ${pendingImport.readyCount === 0 ? '<div class="alert alert-error text-sm"><span>No valid rows were found. Check the file against the downloaded template and try again.</span></div>' : ''}
      <div class="flex gap-2">
        <button type="button" class="btn btn-outline" data-onboarding-cancel-preview ${busy ? 'disabled' : ''}>${isAi ? 'Scan a different photo' : 'Choose a different file'}</button>
        <button type="button" class="btn btn-primary" data-onboarding-confirm-preview ${busy || !pendingImport.readyCount ? 'disabled' : ''}>
          ${busy ? 'Importing…' : `Import ${pendingImport.readyCount} row${pendingImport.readyCount === 1 ? '' : 's'}`}
        </button>
      </div>
    </section>
  `;
}

// "Add one manually instead" used to navigate to the real Suppliers/Stock Items screen and open
// its full editor — now it just reveals this small inline form, right here in the wizard. Only
// `name` is required by upsertSupplier/upsertStockItem; everything else on the real editors
// (address, terms, thresholds, UOM, ...) is optional/defaulted, so a couple of fields is enough
// for a quick add during setup — the full editor is still there later for anything more.
function renderQuickAddForm(kind, busy) {
  if (kind === 'suppliers') {
    return `
      <form class="flex flex-col gap-2 border border-base-200 rounded-box p-4" data-onboarding-quickadd-form data-onboarding-quickadd-kind="suppliers">
        <input type="text" name="name" class="input input-bordered input-sm" placeholder="Supplier name" autofocus ${busy ? 'disabled' : ''} />
        <div class="flex gap-2">
          <input type="text" name="contactPerson" class="input input-bordered input-sm flex-1" placeholder="Contact person (optional)" ${busy ? 'disabled' : ''} />
          <input type="text" name="phone" class="input input-bordered input-sm flex-1" placeholder="Phone (optional)" ${busy ? 'disabled' : ''} />
        </div>
        <div class="flex gap-2 justify-end mt-1">
          <button type="button" class="btn btn-ghost btn-sm" data-onboarding-quickadd-cancel ${busy ? 'disabled' : ''}>Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}>${busy ? 'Adding…' : 'Add Supplier'}</button>
        </div>
      </form>
    `;
  }
  return `
    <form class="flex flex-col gap-2 border border-base-200 rounded-box p-4" data-onboarding-quickadd-form data-onboarding-quickadd-kind="stock">
      <input type="text" name="name" class="input input-bordered input-sm" placeholder="Stock item name" autofocus ${busy ? 'disabled' : ''} />
      <input type="text" name="cost" class="input input-bordered input-sm" inputmode="decimal" placeholder="Cost (optional)" ${busy ? 'disabled' : ''} />
      <div class="flex gap-2 justify-end mt-1">
        <button type="button" class="btn btn-ghost btn-sm" data-onboarding-quickadd-cancel ${busy ? 'disabled' : ''}>Cancel</button>
        <button type="submit" class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}>${busy ? 'Adding…' : 'Add Stock Item'}</button>
      </div>
    </form>
  `;
}

// Shared by every file input in the wizard (bulk CSV/XLSX import and AI photo scan alike) — a
// click-to-browse button plus a drag-and-drop target over the same hidden <input>, so both paths
// end up firing the exact same change/drop handling (see bindImportInput/bindDropzone below).
// The dragover highlight is a plain class toggle in JS rather than :hover-style CSS, since
// "a file is being dragged over this element" isn't something CSS alone can express.
function renderFileDropzone({ attr, accept, capture = false, disabled = false, buttonClass = 'btn-primary', buttonSize = '', buttonLabel = 'Choose File', hint = '' }) {
  return `
    <div class="onboarding-dropzone flex flex-wrap gap-3 items-center border-2 border-dashed border-base-300 rounded-box p-3 transition-colors" data-onboarding-dropzone="${escapeAttribute(attr)}">
      <input type="file" accept="${escapeAttribute(accept)}" ${capture ? 'capture="environment"' : ''} hidden ${attr}-input />
      <button type="button" class="btn ${buttonSize} ${buttonClass}" ${attr}-trigger ${disabled ? 'disabled' : ''}>${buttonLabel}</button>
      <span class="text-xs opacity-60">${escapeHtml(hint)}</span>
    </div>
  `;
}

function renderImportStep(context, { kind, title, description, countLabel, count, inputAttr, accept, downloadTemplateAttr, addManuallyAttr, aiInputAttr, aiHint }) {
  if (context.pendingImport?.kind === kind) return renderImportPreviewPanel(context.pendingImport, context.actionStatus);
  const busy = context.actionStatus === 'importing';
  const scanning = context.actionStatus === 'scanningAi';
  const quickAddOpen = context.quickAdd?.kind === kind;
  return `
    <section class="flex flex-col gap-4">
      <h3 class="font-semibold text-base">${escapeHtml(title)}</h3>
      <p class="text-sm opacity-80">${escapeHtml(description)}</p>
      ${count !== null ? `<div class="badge badge-outline">${escapeHtml(countLabel(count))}</div>` : ''}
      <button type="button" class="btn btn-outline btn-sm self-start" ${downloadTemplateAttr}>Download Template</button>
      ${renderFileDropzone({
        attr: inputAttr,
        accept,
        disabled: busy || scanning,
        buttonClass: 'btn-primary',
        buttonSize: '',
        buttonLabel: busy ? 'Reading file…' : 'Import Bulk',
        hint: 'or drag & drop a file here'
      })}
      ${context.aiOnboardingEnabled ? `
        <div class="divider text-xs opacity-60 my-0">or</div>
        ${renderFileDropzone({
          attr: aiInputAttr,
          accept: 'image/*',
          capture: true,
          disabled: busy || scanning,
          buttonClass: 'btn-secondary',
          buttonSize: 'btn-sm',
          buttonLabel: scanning ? (context.actionNote ? 'Queued…' : 'Scanning…') : '✨ Scan a photo with AI',
          hint: scanning && context.actionNote ? context.actionNote : `${aiHint || 'Upload a photo of a document with this data'}, or drag & drop it here`
        })}
      ` : ''}
      <div class="divider text-xs opacity-60 my-0">or</div>
      ${quickAddOpen
        ? renderQuickAddForm(kind, busy)
        : `<button type="button" class="btn btn-ghost btn-sm self-start" ${addManuallyAttr}>Add one manually instead</button>`}
    </section>
  `;
}

const QUICK_RECIPE_ROW_COUNT = 4;

// "Build recipes one at a time in Recipes" used to navigate away to the real Recipes screen and
// open its full recipe editor — now it's this small inline builder instead, reusing updateRecipe
// against the SAME already-synced product (no new product is created; Yoco already has it, it
// just has no recipe yet). Capped at a fixed 4 ingredient rows rather than a dynamic add/remove
// table — enough for a quick add during setup, and simpler than reproducing the real editor's
// full row-management UI in a wizard step.
function renderQuickRecipeBuilder(recipeBuilder, actionStatus) {
  const busy = actionStatus === 'savingRecipe';
  if (recipeBuilder.loading) {
    return `<div class="border border-base-200 rounded-box p-4 text-sm opacity-70">Loading products and stock items…</div>`;
  }
  const products = recipeBuilder.products || [];
  const stockItems = recipeBuilder.stockItems || [];
  if (!products.length) {
    return `<div class="alert alert-success text-sm"><span>Every synced product already has a recipe.</span></div>`;
  }
  if (!stockItems.length) {
    return `<div class="alert alert-warning text-sm"><span>Add stock items first (previous step); a recipe needs at least one to reference.</span></div>`;
  }
  const stockOptions = stockItems.map((item) => `<option value="${escapeAttribute(item.id)}">${escapeHtml(item.name)}</option>`).join('');
  const rows = Array.from({ length: QUICK_RECIPE_ROW_COUNT }, (_, index) => `
    <div class="flex gap-2">
      <select name="ingredientStockItemId[]" class="select select-bordered select-sm flex-1" ${busy ? 'disabled' : ''}>
        <option value="">${index === 0 ? 'Select an ingredient…' : '(unused)'}</option>
        ${stockOptions}
      </select>
      <input type="text" name="ingredientQty[]" class="input input-bordered input-sm w-24" inputmode="decimal" placeholder="Qty" ${busy ? 'disabled' : ''} />
    </div>
  `).join('');
  return `
    <form class="flex flex-col gap-3 border border-base-200 rounded-box p-4" data-onboarding-quickrecipe-form>
      <select name="productId" class="select select-bordered select-sm" ${busy ? 'disabled' : ''}>
        <option value="">Select a product…</option>
        ${products.map((product) => `<option value="${escapeAttribute(product.id)}">${escapeHtml(product.name)}</option>`).join('')}
      </select>
      <p class="text-xs opacity-60">Add up to ${QUICK_RECIPE_ROW_COUNT} ingredients with their quantities:</p>
      ${rows}
      <div class="flex gap-2 justify-end mt-1">
        <button type="button" class="btn btn-ghost btn-sm" data-onboarding-quickrecipe-cancel ${busy ? 'disabled' : ''}>Cancel</button>
        <button type="submit" class="btn btn-primary btn-sm" ${busy ? 'disabled' : ''}>${busy ? 'Saving…' : 'Save Recipe'}</button>
      </div>
    </form>
  `;
}

function renderRecipesStep({ counts, actionStatus, actionNote, pendingImport, recipeBuilder, aiOnboardingEnabled }) {
  if (pendingImport?.kind === 'recipes') return renderImportPreviewPanel(pendingImport, actionStatus);
  const missing = counts?.missingRecipeCount ?? null;
  const busyImport = actionStatus === 'importing';
  const busyExport = actionStatus === 'exporting';
  const scanning = actionStatus === 'scanningAi';
  return `
    <section class="flex flex-col gap-4">
      <h3 class="font-semibold text-base">Build your recipes</h3>
      <p class="text-sm opacity-80">Every synced product needs a recipe (its ingredient list) before it can drive stock deduction and true cost reporting. Download a template pre-filled with the products that still need one, fill in ingredients and quantities, then import it back.</p>
      ${missing !== null ? `<div class="badge ${missing === 0 ? 'badge-success' : 'badge-outline'}">${missing} product${missing === 1 ? '' : 's'} still missing a recipe</div>` : ''}
      <button type="button" class="btn btn-outline btn-sm self-start" data-onboarding-download-recipe-template ${busyExport ? 'disabled' : ''}>
        ${busyExport ? 'Preparing…' : 'Download Pre-filled Template'}
      </button>
      ${renderFileDropzone({
        attr: 'data-onboarding-import-recipes',
        accept: '.csv,.xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv',
        disabled: busyImport || scanning,
        buttonClass: 'btn-primary',
        buttonLabel: busyImport ? 'Reading file…' : 'Import Filled-in Template',
        hint: 'or drag & drop a file here'
      })}
      <p class="text-xs opacity-60">Ingredients must already exist as stock items (previous step); import stock items first if a row fails to match.</p>
      ${aiOnboardingEnabled ? `
        <div class="divider text-xs opacity-60 my-0">or</div>
        ${renderFileDropzone({
          attr: 'data-onboarding-scan-recipes',
          accept: 'image/*',
          capture: true,
          disabled: busyImport || scanning,
          buttonClass: 'btn-secondary',
          buttonSize: 'btn-sm',
          buttonLabel: scanning ? (actionNote ? 'Queued…' : 'Scanning…') : '✨ Scan a recipe card with AI',
          hint: scanning && actionNote ? actionNote : 'Matches ingredients/quantities to products still missing a recipe, or drag & drop a photo here'
        })}
      ` : ''}
      <div class="divider text-xs opacity-60 my-0">or</div>
      ${recipeBuilder
        ? renderQuickRecipeBuilder(recipeBuilder, actionStatus)
        : `<button type="button" class="btn btn-ghost btn-sm self-start" data-onboarding-open-recipes>Build one recipe at a time</button>`}
    </section>
  `;
}

function renderFinishStep({ counts }) {
  const rows = [
    { label: 'Products synced from POS', value: counts?.productCount },
    { label: 'Suppliers', value: counts?.supplierCount },
    { label: 'Stock items', value: counts?.stockItemCount },
    { label: 'Products still missing a recipe', value: counts?.missingRecipeCount }
  ];
  return `
    <section class="flex flex-col gap-4">
      <h3 class="font-semibold text-base">You're set up</h3>
      <p class="text-sm opacity-80">You can always come back to any step: import more suppliers, stock items, or recipes any time from their own screens, or reopen this wizard from Settings.</p>
      <ul class="flex flex-col divide-y divide-base-200 border border-base-200 rounded-box">
        ${rows.map((row) => `
          <li class="flex items-center justify-between px-4 py-2 text-sm">
            <span class="opacity-70">${escapeHtml(row.label)}</span>
            <strong>${row.value ?? '-'}</strong>
          </li>
        `).join('')}
      </ul>
    </section>
  `;
}

function renderWizardFooter(wizardStep, onboarding) {
  const disabled = onboarding.actionStatus ? 'disabled' : '';
  return `
    <div class="modal-action justify-between">
      <button type="button" class="btn btn-outline" data-onboarding-dismiss>Skip for now</button>
      <div class="flex gap-2">
        ${wizardStep > 1 ? `<button type="button" class="btn btn-outline" data-onboarding-go-back ${disabled}>Back</button>` : ''}
        ${wizardStep < 5
          ? `<button type="button" class="btn btn-primary" data-onboarding-go-next ${disabled}>Next</button>`
          : `<button type="button" class="btn btn-primary" data-onboarding-finish ${disabled}>Finish</button>`}
      </div>
    </div>
  `;
}

// Shell-level events: bound exactly once, when the shell is first created. The dismiss button and
// backdrop live in the shell markup (not re-rendered on step changes), so they never need rebinding.
export function bindOnboardingWizardShellEvents(view, onOnboardingAction = {}) {
  view.querySelector('[data-onboarding-backdrop]')?.addEventListener('mousedown', (event) => {
    if (event.target === event.currentTarget) onOnboardingAction.onDismiss?.();
  });
  view.querySelector('[data-onboarding-dismiss]')?.addEventListener('click', () => onOnboardingAction.onDismiss?.());
}

function bindPaneEvents(paneEl, onOnboardingAction) {
  paneEl.querySelector('[data-onboarding-sync-now]')?.addEventListener('click', () => onOnboardingAction.onSyncNow?.());
  paneEl.querySelector('[data-onboarding-download-recipe-template]')?.addEventListener('click', () => onOnboardingAction.onDownloadRecipeTemplate?.());
  paneEl.querySelector('[data-onboarding-download-supplier-template]')?.addEventListener('click', () => onOnboardingAction.onDownloadSupplierTemplate?.());
  paneEl.querySelector('[data-onboarding-download-stock-template]')?.addEventListener('click', () => onOnboardingAction.onDownloadStockTemplate?.());
  paneEl.querySelector('[data-onboarding-cancel-preview]')?.addEventListener('click', () => onOnboardingAction.onCancelImportPreview?.());
  paneEl.querySelector('[data-onboarding-confirm-preview]')?.addEventListener('click', () => {
    onOnboardingAction.onConfirmImportPreview?.(readPreviewFieldEdits(paneEl));
  });

  paneEl.querySelectorAll('[data-onboarding-preview-edit]').forEach((btn) => {
    btn.addEventListener('click', () => onOnboardingAction.onEditPreviewRow?.(Number(btn.dataset.rowIndex), readPreviewFieldEdits(paneEl)));
  });
  paneEl.querySelector('[data-onboarding-preview-cancel-edit]')?.addEventListener('click', () => onOnboardingAction.onEditPreviewRow?.(-1));
  paneEl.querySelectorAll('[data-onboarding-preview-save]').forEach((btn) => {
    btn.addEventListener('click', () => onOnboardingAction.onSavePreviewRow?.(Number(btn.dataset.rowIndex), readPreviewFieldEdits(paneEl)));
  });
  paneEl.querySelectorAll('[data-onboarding-preview-delete]').forEach((btn) => {
    btn.addEventListener('click', () => onOnboardingAction.onDeletePreviewRow?.(Number(btn.dataset.rowIndex), readPreviewFieldEdits(paneEl)));
  });

  bindImportInput(paneEl, 'data-onboarding-import-suppliers', onOnboardingAction.onImportSuppliers);
  bindImportInput(paneEl, 'data-onboarding-import-stock', onOnboardingAction.onImportStock);
  bindImportInput(paneEl, 'data-onboarding-import-recipes', onOnboardingAction.onImportRecipes);
  bindImportInput(paneEl, 'data-onboarding-scan-suppliers', onOnboardingAction.onScanSuppliersWithAi);
  bindImportInput(paneEl, 'data-onboarding-scan-stock', onOnboardingAction.onScanStockWithAi);
  bindImportInput(paneEl, 'data-onboarding-scan-recipes', onOnboardingAction.onScanRecipesWithAi);

  paneEl.querySelector('[data-onboarding-connect-yoco-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const apiKey = String(event.currentTarget.querySelector('[name="apiKey"]')?.value || '').trim();
    onOnboardingAction.onConnectYoco?.(apiKey);
  });

  paneEl.querySelector('[data-onboarding-add-supplier-manually]')?.addEventListener('click', () => onOnboardingAction.onToggleQuickAdd?.('suppliers'));
  paneEl.querySelector('[data-onboarding-add-stock-manually]')?.addEventListener('click', () => onOnboardingAction.onToggleQuickAdd?.('stock'));
  paneEl.querySelector('[data-onboarding-quickadd-cancel]')?.addEventListener('click', () => onOnboardingAction.onCancelQuickAdd?.());
  paneEl.querySelector('[data-onboarding-quickadd-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const kind = form.dataset.onboardingQuickaddKind;
    const fields = {
      name: String(form.querySelector('[name="name"]')?.value || '').trim(),
      contactPerson: String(form.querySelector('[name="contactPerson"]')?.value || '').trim(),
      phone: String(form.querySelector('[name="phone"]')?.value || '').trim(),
      cost: String(form.querySelector('[name="cost"]')?.value || '').trim()
    };
    if (kind === 'suppliers') onOnboardingAction.onSubmitQuickAddSupplier?.(fields);
    else onOnboardingAction.onSubmitQuickAddStock?.(fields);
  });

  paneEl.querySelector('[data-onboarding-open-recipes]')?.addEventListener('click', () => onOnboardingAction.onToggleRecipeBuilder?.());
  paneEl.querySelector('[data-onboarding-quickrecipe-cancel]')?.addEventListener('click', () => onOnboardingAction.onCancelRecipeBuilder?.());
  paneEl.querySelector('[data-onboarding-quickrecipe-form]')?.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const productId = String(form.querySelector('[name="productId"]')?.value || '');
    const stockItemIds = Array.from(form.querySelectorAll('[name="ingredientStockItemId[]"]')).map((el) => el.value);
    const qtys = Array.from(form.querySelectorAll('[name="ingredientQty[]"]')).map((el) => el.value);
    const ingredients = stockItemIds
      .map((stockItemId, index) => ({ stockItemId, qty: qtys[index] }))
      .filter((row) => row.stockItemId && Number(row.qty) > 0);
    onOnboardingAction.onSubmitQuickRecipe?.({ productId, ingredients });
  });
}

// Snapshots every currently-rendered preview-table input (the always-open Category field on
// every row, plus every field on whichever row is mid-edit) right before an action that would
// re-render the table — edit/save/cancel/delete/confirm all call this first so a Category edit
// on row 1 isn't silently discarded just because the user clicked delete on row 3.
function readPreviewFieldEdits(paneEl) {
  return Array.from(paneEl.querySelectorAll('[data-onboarding-preview-field]')).map((input) => ({
    index: Number(input.dataset.rowIndex),
    key: input.dataset.fieldKey,
    value: input.value
  }));
}

function bindFooterEvents(footerEl, onOnboardingAction) {
  footerEl.querySelector('[data-onboarding-dismiss]')?.addEventListener('click', () => onOnboardingAction.onDismiss?.());
  footerEl.querySelector('[data-onboarding-finish]')?.addEventListener('click', () => onOnboardingAction.onFinish?.());
  footerEl.querySelector('[data-onboarding-go-next]')?.addEventListener('click', () => onOnboardingAction.onGoNext?.());
  footerEl.querySelector('[data-onboarding-go-back]')?.addEventListener('click', () => onOnboardingAction.onGoBack?.());
}

function bindImportInput(view, attr, handler) {
  const input = view.querySelector(`[${attr}-input]`);
  view.querySelector(`[${attr}-trigger]`)?.addEventListener('click', () => input?.click());
  input?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    if (file) handler?.(file);
    event.target.value = '';
  });

  // Same handler as the click-to-browse path above — drag-and-drop is just a second way to
  // supply the same file, not a separate feature with its own logic.
  const dropzone = view.querySelector(`[data-onboarding-dropzone="${attr}"]`);
  if (!dropzone) return;
  let dragDepth = 0; // dragenter/dragleave fire on every child too; a plain counter avoids the
  // highlight flickering off while the pointer crosses a child element (button/input/span) on its
  // way across the zone.
  const activeClasses = ['border-primary', 'bg-primary/10'];
  dropzone.addEventListener('dragenter', (event) => {
    event.preventDefault();
    dragDepth += 1;
    dropzone.classList.add(...activeClasses);
  });
  dropzone.addEventListener('dragover', (event) => event.preventDefault());
  dropzone.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropzone.classList.remove(...activeClasses);
  });
  dropzone.addEventListener('drop', (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropzone.classList.remove(...activeClasses);
    const file = event.dataTransfer?.files?.[0];
    if (file) handler?.(file);
  });
}

function formatRelativeTimestamp(value) {
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const diffMinutes = Math.round((Date.now() - ms) / 60000);
  if (diffMinutes < 1) return 'moments ago';
  if (diffMinutes < 60) return `${diffMinutes} min ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.round(diffHours / 24)}d ago`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function escapeAttribute(value) {
  return escapeHtml(value);
}
