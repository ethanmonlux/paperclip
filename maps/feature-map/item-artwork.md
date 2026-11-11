---
navigation: {"section":"Projects and execution","sectionOrder":40,"order":81}
---

# Item artwork

An authorized company member can open the latest published item explorer snapshot directly from persistent navigation.

Feature ID: `item-artwork`.

Implementation: [viewer](../../ui/src/pages/ItemArtwork.tsx), [navigation](../../ui/src/components/MobileBottomNav.tsx), [HTML preview](../../ui/src/components/HtmlArtifactPreview.tsx).

Agent access: [companion](../agent-access-map/item-artwork.md).

## Sub-features

- `navigation`: `item-artwork/navigation` — open the company-scoped explorer from desktop or phone navigation.
- `snapshot`: `item-artwork/snapshot` — follow the stable STA-290 work product to its latest authorized HTML attachment.
- `return`: `item-artwork/return` — visible Back returns to a known same-company app view or Console, and Home opens Console directly.

## How to get to it (user POV)

### `navigation-button`

Tap Item artwork in the sidebar or phone bottom bar.

### `direct-route`

Open `/:companyPrefix/item-artwork` in the authenticated app.

## Driving it

Preconditions: select a company with read access to STA-290 and its attachment.

Automated: [navigation test](../../ui/src/components/ConsoleNav.test.tsx) checks the persistent entry and active route. The existing [HTML preview tests](../../ui/src/lib/html-preview.test.ts) cover the preview security policy.

Manual: At 390 and 430 CSS px, open the route, reload, use Back and Home from loading, empty and failure states, and exercise the explorer tabs, touch search and detail. Publish a replacement attachment on the stable work product and confirm the same route opens it. Check missing, failed and unauthorized attachment states.

## Gotchas

- This is a published snapshot; discovery and new publication belong to STA-290.
- Source and installed versions may differ until the nightly watcher activates merged code.
