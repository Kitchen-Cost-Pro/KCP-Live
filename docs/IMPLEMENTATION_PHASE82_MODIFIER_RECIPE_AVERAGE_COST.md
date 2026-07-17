# Phase 82 — Modifier Recipe Average Cost

## Fixed

The Recipes screen previously removed Yoco modifier option records before opening the menu-item recipe blueprint. The costing panel therefore saw the attached modifier group, but could not see its options, and displayed **Pending**.

The recipe UI now keeps two collections:

- visible menu products for the Recipes table;
- the complete product + modifier catalogue for modifier cost resolution.

## Cost formula

For each attached modifier set:

`average modifier cost = sum of option recipe costs / total catalogue options`

Example: five options costing R7 each:

`(R7 × 5) / 5 = R7 average modifier cost`

The combined values remain:

- `average combined cost = base recipe cost + average modifier cost`
- `combined GP% = (average combined selling - average combined cost) / average combined selling`

Location-specific ingredient costs continue to be resolved through the existing stock cost resolver.

## Compatibility

No sale deduction, refund, recipe persistence, modifier mapping, or reporting behaviour was changed. This patch only restores modifier option visibility to the existing recipe costing calculation and locks the denominator to the attached catalogue option count.
