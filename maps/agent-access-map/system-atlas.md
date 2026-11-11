# System Atlas — agent access

Product map: [System Atlas](../feature-map/system-atlas.md).

Feature ID: `system-atlas`.

Review date: 2026-11-11. Source revision: STA-289 candidate, not yet integrated.

## `exploration`

Capability ID: `system-atlas/exploration`.

API: `GET /api/companies/{companyId}/staple-console` supplies current evidence.

Agent access: available to authorized company and task readers through the existing Console route.

Policy: Company access and readable issue filters apply; the page does not grant new task access.

Evidence: source-only; live route not yet installed.

Verification: after activation, use an authorized company and a denied/private task to check the boundary.

## `freshness`

Capability ID: `system-atlas/freshness`.

API: `GET /api/companies/{companyId}/system-atlas/source`.

Agent access: company-scoped read with an existing viewer-scoped or company GitHub credential; no credential yields unknown.

Policy: Company access required. A missing or failed provider read must not say current.

Evidence: source-only; candidate service and tests in STA-289.

Verification: compare source and installed revisions after a relevant merge, then fail refresh and check last-good unknown state.
