# Item artwork — agent access

Product map: [Item artwork](../feature-map/item-artwork.md).

Feature ID: `item-artwork`.

Review date: 2026-11-11. Source revision: STA-289 candidate, not yet integrated.

## `navigation`

Capability ID: `item-artwork/navigation`.

Review: `baseline`.

API: `not-applicable` — navigation is a client route inside the authenticated company shell.

Agent access: `available` — an authorized company member can open the route.

Policy: The selected company must match the work product company; navigation does not grant task access.

Evidence: `source-only` — live route not yet installed.

Verification: `not-run` — verify the installed route at 390 and 430 CSS px after watcher activation.

Gaps: Live phone navigation and Back behavior have not been observed.

## `snapshot`

Capability ID: `item-artwork/snapshot`.

Review: `baseline`.

API: `present` — `GET /api/issues/{issueId}/work-products`, `GET /api/issues/{issueId}/attachments`, and `GET /api/attachments/{attachmentId}/content`.

Agent access: `available` — existing task and attachment read authorization applies to each request.

Policy: The stable work product must belong to STA-290 and the selected company. Its target must appear in the authorized attachment list and fit the HTML preview size limit.

Evidence: `source-only` — current STA-290 work product and attachment were observed, but this route has not been installed.

Verification: `not-run` — replace the pointer, fail a content read, and deny task access in the installed app.

Gaps: Changed pointer and failure behavior need installed acceptance.
