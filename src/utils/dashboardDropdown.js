/**
 * Calculates an exact menu width and horizontal offset for a dashboard custom select.
 * Keeping this calculation independent of CSS percentage sizing prevents Safari from
 * resolving a first-open menu against the full flex row before the select field settles.
 */
export function getDashboardSelectMenuLayout({
  buttonRect = {},
  fieldRect = {},
  viewportWidth = 0,
  viewportPadding = 12,
  minimumWidth = 190
} = {}) {
  const safeViewportWidth = Math.max(1, Number(viewportWidth) || 1);
  const safePadding = Math.max(0, Number(viewportPadding) || 0);
  const availableWidth = Math.max(1, safeViewportWidth - safePadding * 2);
  const safeMinimumWidth = Math.min(Math.max(1, Number(minimumWidth) || 1), availableWidth);
  const measuredWidth = Math.max(0, Number(buttonRect.width) || Number(fieldRect.width) || 0);
  const width = Math.min(Math.max(measuredWidth, safeMinimumWidth), availableWidth);
  const fieldLeft = Number(fieldRect.left) || 0;
  const rightmostLeft = safeViewportWidth - safePadding - width;
  let left = Math.min(0, rightmostLeft - fieldLeft);

  // Keep the menu inside the left edge as well when a narrow viewport or transformed parent
  // reports the trigger close to (or beyond) the viewport boundary.
  left = Math.max(left, safePadding - fieldLeft);

  return { width, left };
}

export function positionDashboardSelectMenu(view, kind = '', viewportWidth = globalThis.window?.innerWidth || 0) {
  if (!view || !kind) return null;
  const button = view.querySelector(`[data-dashboard-select-button="${kind}"]`);
  const menu = view.querySelector(`[data-dashboard-select-menu="${kind}"]`);
  const field = button?.closest('[data-dashboard-custom-select]');
  if (!button || !menu || !field || menu.hidden) return null;

  const layout = getDashboardSelectMenuLayout({
    buttonRect: button.getBoundingClientRect(),
    fieldRect: field.getBoundingClientRect(),
    viewportWidth
  });

  // Pin all three dimensions so a legacy min/max rule or a flex reflow cannot change the
  // first painted width. The next open and every resize recalculate these values.
  menu.style.width = `${layout.width}px`;
  menu.style.minWidth = `${layout.width}px`;
  menu.style.maxWidth = `${layout.width}px`;
  menu.style.left = `${layout.left}px`;
  return layout;
}
