# Release Audit: Phase V2 01-03 Yoco Engine Foundation

Release: `phase-v2-01-03-yoco-engine-foundation`

Audit date: 2026-07-15

## Scope result

| Requirement | Result | Evidence |
|---|---|---|
| Legacy integration not removed | PASS | Original webhook route, signature verifier, subscription service, sale processor, refund processor, retries, manual sync, and admin routes remain present and compile. |
| Legacy marked maintenance-only | PASS | `docs/yoco-v2/LEGACY_MAINTENANCE_POLICY.md`. |
| Isolated V2 boundary | PASS | `cloudflare-v2/src/modules/yoco-engine-v2/`. |
| One external Yoco webhook ingress | PASS | Existing `POST /webhooks/yoco/:workspaceId` remains the only ingress. V2 creates no subscription. |
| V2 capture after signature verification | PASS | The existing verifier returns on failure before `captureVerifiedYocoV2EventSafely` is called. |
| Capture does not block or break legacy | PASS | Capture is scheduled through Durable Object `waitUntil`; safe wrapper records failure and resolves. |
| Immutable exact payload capture | PASS | Exact request body is stored; payload identity fields and deletion are protected by database triggers. |
| Deterministic deduplication | PASS | Unique event key uses provider ID first, then stable references and payload hash. Duplicate metadata and timeline are recorded without duplicate queue work. |
| Dedicated queue and DLQ | PASS | `kcp-yoco-v2-events` and `kcp-yoco-v2-events-dlq` bindings and consumer configuration are present. |
| Idempotent queue processing | PASS | Database processing claim, attempt-number uniqueness, stale-lock recovery, and terminal-state acknowledgement are implemented. |
| Retry policy | PASS | Error classification, exponential backoff, jitter, `Retry-After`, maximum attempts, next retry timestamp, and DLQ handling are implemented. |
| Processing runs | PASS | `yoco_v2_processing_runs` includes all required fields and statuses. |
| Append-only timeline | PASS | `yoco_v2_processing_timeline` has update and delete rejection triggers. |
| Admin diagnostics | PASS | Summary, events, event detail, timeline, ownership, dead letters, replay, requeue, and manual-review APIs are segregated under `yoco-v2` and require an internal central-admin role. |
| Structured logs and metric-ready fields | PASS | Trace, event, workspace, integration, type, attempt, status, duration, and error category are logged. |
| V2 live sale reporting writes | PASS, none present | Live flag hard-disabled; no V2 `yoco_orders` or `yoco_order_lines` insert path. |
| V2 live sale stock writes | PASS, none present | Live flag hard-disabled; no V2 `stock_movements` insert or `stock_balances` update. |
| V2 live refund reporting writes | PASS, none present | Live flag hard-disabled; no refund resolver or reporting write path. |
| V2 live refund stock writes | PASS, none present | Live flag hard-disabled; no refund return or stock write path. |
| Effect ownership remains legacy | PASS | Four ownership rows are seeded as `LEGACY`; tests assert the state. |
| All Markdown files moved to one directory | PASS | Project Markdown is under `docs/`; dependency folders are excluded from the release archive. |
| Rollback documented | PASS | `docs/yoco-v2/ROLLBACK.md`. |

## Automated test coverage

The suite at `cloudflare-v2/tests/yoco-engine-v2.test.ts` verifies:

1. Valid webhook captured once.
2. Duplicate webhook does not duplicate the raw event or queue work.
3. Invalid signature does not enter V2 processing.
4. Exact payload preservation and secret-header redaction.
5. V2 capture failure does not break the legacy path contract.
6. Queue publication succeeds.
7. Queue publication failure is observable.
8. Consumer processing is idempotent.
9. Temporary error schedules retry.
10. Permanent error does not retry indefinitely.
11. Exhausted event enters dead-letter state.
12. Replay does not duplicate the raw event.
13. Timeline is append-only and raw payload fields are immutable.
14. Live-write flags remain false.
15. Effect ownership remains `LEGACY`.
16. Rate-limit classification and `Retry-After` behavior.
17. Queue batch acknowledgement and retry behavior.
18. Deterministic event identity.
19. Legacy webhook path and processors remain present while the V2 module contains no stock or reporting writes.
20. Admin replay publication failure remains observable and replayable.
21. Queue-disable policy pauses an already-published event without creating a processing attempt.
22. `next_attempt_at` prevents an early retry from acquiring a processing lock.
23. Admin and queue Durable Object routes reject normal workspace-member identities.

## Validation commands

```bash
npm test
npm run build
npm --prefix cloudflare-v2 test
npm --prefix cloudflare-v2 run typecheck
npm --prefix cloudflare-v2 run deploy:dry
```

Validation outcome:

- Root regression suite: 493 passed, 0 failed.
- Yoco V2 foundation suite: 22 passed, 0 failed.
- Frontend production build: passed.
- Worker TypeScript typecheck: passed.
- Wrangler production dry-run: passed with both queue bindings detected and all live-write flags false.

## Release conclusion

The engine foundation is safe to deploy with all V2 feature flags false. Capture, queue, and admin can then be enabled selectively by workspace. The legacy engine remains the only live-effect owner, and no V2 stock or reporting effect exists in this release.
