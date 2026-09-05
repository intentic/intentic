# @intentic/ext-browsers

The browser families a user can connect their own copy of, as something the agent can work inside.

## Responsibilities

- Declare the `webext` capability cards (Chrome, Edge) and where each family's extension is installed from.
- Ship the skill that teaches an agent to work in somebody's own browser: which browser to reach for, what
  Chromium will and will not let it touch, and the etiquette that keeps the connection installed.

## Key files

- [intentic-extension.json](intentic-extension.json): the cards. This file IS the package; there is no `src/`.
- [skills/chrome](skills/chrome): one pack, shared by both cards — Edge is Chromium and the extension is the same one.

## How it fits

Purely declarative, like [ext-devices](../devices). The extension that makes this possible lives in
[`_devices/webext`](../../_devices/webext), the socket and the tool bridge in the daemon's `webext/`, and the
enforcement in neither of them: per-site permission is the browser's own, granted by the person in the popup.

## Conventions & gotchas

- **A second card is a second browser, not a second product.** Edge points at a different store listing and
  reuses the Chrome skill, because nothing an agent does differs between them. A family whose behaviour genuinely
  differs (Firefox's containers, Safari's extension model) gets its own pack when it gets its own card.
- **`install` is a URL rather than a store id** — the families do not share a store, and an unlisted build is a
  zip on a page. The connect dialog renders it as the link.
