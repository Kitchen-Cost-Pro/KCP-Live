# Phase 88: Modifier Reporting and Linked Items

## Delivered

### Modifier reporting identity
- Canonical Yoco V2 sale metadata now preserves the sold modifier name, group, variant identity, and modifier type.
- Modifier reports resolve canonical `source_*` fields before using legacy fallbacks, preventing generic `Yoco Modifier` labels.
- Product modifiers report as **Product**, structured options as **Option**, and free-text note modifiers as **Note**.

### Stock action reporting
- Modifier report rows include a **Stock Action** field across Summary, GP Tracker, By Group, By Modifier, and Sales Log views.
- Supported labels are:
  - Add recipe
  - Add stock item
  - Remove ingredient
  - Replace ingredient
  - No stock change
- Export mappings include the same stock action information.

### Modifier catalogue actions
- Removed the duplicate Setup column/button from the modifier table.
- Replaced the native Stock Action `<select>` with the KCP custom dropdown/listbox.
- Choosing an action opens the stock-action configuration drawer with that action selected.
- Linked Items now opens a separate read-only modal listing every linked menu item instead of opening configuration.

### Replace ingredient setup
- Replace Ingredient now asks two explicit questions:
  - What are we replacing from the base recipe?
  - What should replace it?
- The source selector is limited to ingredients actually resolved from the linked/menu-scoped base recipes.
- Sub-recipes and virtual/prep recipe sources are expanded using the same eligibility rules as the Worker modifier engine.
- The replacement selector prevents selecting the same ingredient and blocks incompatible base UOM replacements.

## Verification

- Frontend test suite: 473 passed, 0 failed.
- Worker test suite: 64 passed, 0 failed.
- Worker TypeScript typecheck: passed.
- Frontend production build: passed.
- Cloudflare Worker dry-run deployment bundle: passed.

The Vite build continues to emit the existing chunk-size and mixed static/dynamic import warnings; these do not block the build.
