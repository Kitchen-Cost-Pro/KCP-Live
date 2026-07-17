# Phase 87 - Beta Release Hardening

Date: 2026-07-16

## Purpose

Close the six remaining regression-suite failures before the beta release candidate.

## Changes

The six failing tests were stale source-pattern assertions rather than missing runtime behavior. They only accepted single-quoted or unformatted source text, while the current TypeScript implementation uses double quotes and formatter-added whitespace.

Updated the assertions to remain behaviorally strict while accepting equivalent TypeScript formatting for:

- Admin workspace Durable Object event routing.
- Report schedule PUT routing.
- Super-user-only Yoco key replacement and disconnect protection.
- Workspace Gmail OAuth callback routing.
- Low-stock notification settings routing.
- Refund stock-report identity metadata.

No production route or business behavior was weakened or bypassed.

## Validation

Executed from a clean npm install environment:

- Frontend/source regression suite: 469/469 passed.
- Worker Yoco V2 suite: 64/64 passed.
- Worker TypeScript: passed.
- Vite production build: passed.
- Wrangler deployment dry-run: passed.
- Final Yoco V2 source audit: 26/26 passed.
- Yoco V2 admin dependency audit: passed.

## Remaining external acceptance gate

The production runtime-readiness audit still requires evidence exported from the deployed Cloudflare environment. This evidence cannot be truthfully generated from a local source archive. It must confirm live ownership, queue/DLQ health, reconciliation status, legacy execution counters, and critical failure counts.
