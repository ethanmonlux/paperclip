---
navigation: {"section":"Projects and execution","sectionOrder":40,"order":80}
---

# System Atlas

An authenticated company member can explore Staple's architecture from Console and distinguish authored explanations from current source and installed behavior.

Feature ID: `system-atlas`.

Implementation: [Atlas page](../../ui/src/pages/SystemAtlas.tsx), [authored nodes](../../ui/src/pages/system-atlas-data.ts), [source comparison](../../server/src/services/staple-console.ts).

Agent access: [companion](../agent-access-map/system-atlas.md).

## Sub-features

- `exploration`: `system-atlas/exploration` — navigate seven chapters, linked nodes and walkthroughs at phone width.
- `freshness`: `system-atlas/freshness` — see source, installed and observed revisions and affected explanation nodes.

## How to get to it (user POV)

### `console-link`

Open `/:companyPrefix/console`, then tap System Atlas.

### `atlas-route`

Open `/:companyPrefix/system-atlas` directly within the existing authenticated app.

## Driving it

Preconditions: select a company with access to Console. Source comparison additionally needs an existing authorized GitHub grant.

Automated: [Atlas UI tests](../../ui/src/pages/SystemAtlas.test.tsx) cover chapter, link and phone navigation; [source tests](../../server/src/__tests__/staple-console-github-source.test.ts) cover changed source and failed refresh. Existing [Console service tests](../../server/src/__tests__/staple-console-service.test.ts) exercise private-task filtering.

Manual: Open the native route at 380px and follow a walkthrough. Compare source, installed and observation values. Merge a relevant source change and verify the affected node says stale. Revoke GitHub access or cause a source read failure and verify unknown with last-good evidence. Check that foreign-company and private-task data remain inaccessible.

## Gotchas

- A source change does not mean the installed build changed.
- A green source comparison covers listed repository paths; external contract revisions need separate review.
- The owner-private Atlas reference is design input, not proof of live behavior.
