# Kitchen Cost Pro Legal Pages Implementation Audit

## Release

Phase 63

## Effective date and document version

- Effective date: 14 July 2026
- Version: 2026-07-14

## Implemented pages

- Privacy Policy: `/privacy.html`
- Terms of Service: `/terms.html`
- Shared responsive styling: `/legal.css`

## Authentication changes

### Sign in

The sign-in card displays links to the Privacy Policy and Terms of Service. The links open in a separate tab and use `noopener noreferrer`.

### Registration

Registration now requires the user to:

- agree to the Terms of Service;
- acknowledge the Privacy Policy; and
- accept the current legal document version.

The browser uses a required checkbox. The frontend service validates acceptance again. The Cloudflare Worker also validates the acceptance and rejects missing or outdated versions.

## Acceptance record

The server records the following values in the registration request `raw_json` field:

- `termsAccepted`
- `privacyAcknowledged`
- `legalVersion`
- `acceptedAt`
- `source`

The acceptance time is created by the Worker rather than trusted from the browser.

## South African legal framework considered

The legal copy was structured with reference to:

- Protection of Personal Information Act 4 of 2013 and Information Regulator guidance: https://inforegulator.org.za/
- Electronic Communications and Transactions Act 25 of 2002: https://www.gov.za/documents/electronic-communications-and-transactions-act
- Consumer Protection Act 68 of 2008: https://www.gov.za/documents/consumer-protection-act

## Copy and design requirements

- The new legal copy contains no em dashes.
- Legal wording is formal but readable.
- The pages are responsive for desktop, tablet, and mobile layouts.
- Legal pages use KCP branding and include navigation back to sign in.
- Legal files are copied into the production build by Vite.
- Cache settings allow updated legal versions to become available immediately.

## Important legal information still required from the business

The repository does not contain verified details for:

- the registered legal entity operating KCP;
- company registration number;
- registered or physical address;
- public legal notice email address;
- public privacy or Information Officer email address;
- final subscription cancellation and refund rules; or
- a lawyer-approved liability cap for the commercial model.

The pages therefore identify the KCP service provider and contact details by reference to the applicable order form, subscription agreement, invoice, account, or onboarding communication. These business details should be inserted and reviewed by a South African legal professional before a formal commercial launch.

## Validation

- 431 automated tests passed.
- Frontend production build passed.
- Cloudflare Worker TypeScript validation passed.
- Wrangler deployment dry run passed.
- Internal legal-page links were checked.
- Duplicate section IDs were checked.
- Em dash checks passed for all new legal files.
