# Legacy Yoco Integration Maintenance Policy

Status: maintenance-only, active in production

The legacy Yoco integration remains the sole owner of all sale and refund business effects for this release. It must not be disabled, removed, bypassed, or partially cut over while `integration_effect_ownership` identifies `LEGACY` as the owner.

Legacy Yoco code may receive only:

- security fixes
- corruption prevention
- duplicate prevention
- required diagnostic logging
- critical production fixes

Feature expansion and architectural changes must be implemented inside the isolated Yoco V2 boundary unless a critical production fix cannot safely wait.

## Prohibited during the foundation release

- Removing the legacy webhook processor
- Registering a second Yoco webhook subscription
- Moving any effect ownership to V2
- Writing stock from V2
- Writing financial or operational reporting data from V2
- Calling V2 processing in a way that blocks the legacy webhook response
- Sharing queue messages that contain credentials or secrets
- Editing immutable V2 event payloads

## Cutover precondition

A future effect can move from `LEGACY` to `V2` only after its separate shadow resolver, parity checks, reconciliation controls, idempotency tests, operational runbook, rollback path, and approved release audit are complete.
