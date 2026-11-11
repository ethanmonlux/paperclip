# System Atlas — agent access

Product map: [System Atlas](../feature-map/system-atlas.md).

Feature ID: `system-atlas`.

Review date: 2026-11-11. Source revision: STA-289 candidate, not yet integrated.

## `exploration`

Capability ID: `system-atlas/exploration`.

Review: `baseline`.

API: `present` — `GET /api/companies/{companyId}/staple-console` supplies current evidence.

Agent access: `available` — authorized company and task readers use the existing Console route.

Policy: Company access and readable issue filters apply; the page does not grant new task access.

Evidence: `source-only` — live route not yet installed.

Verification: `not-run` — after activation, use an authorized company and a denied/private task to check the boundary.

Gaps: Live authorization and phone navigation have not been observed.

## `freshness`

Capability ID: `system-atlas/freshness`.

Review: `baseline`.

API: `present` — `GET /api/companies/{companyId}/system-atlas/source`.

Agent access: `available` — company-scoped read with an existing viewer-scoped or company GitHub credential; no credential yields unknown.

Policy: Company access required. A missing or failed provider read must not say current.

Evidence: `source-only` — candidate service and tests in STA-289.

Verification: `not-run` — compare source and installed revisions after a relevant merge, then fail refresh and check last-good unknown state.

Gaps: Semantic refresh routing and live installation evidence remain open.
