# @intentic/ext-preview

What the outside world can reach: a repo's dev server, the ports the box is forwarding, and the files in `public/`.

## Responsibilities

- Show any runnable repo's dev server in an iframe — the fallback for repos no first-party view already serves.
- List what is listening inside the box and what the tunnel currently exposes, and let exposure be revoked.
- Show what is published from the workspace's `public/` folder with nothing running at all.

## Key files

- [src/usePanels.ts](src/usePanels.ts) — the dev-server panel, and which repo claims it.
- [src/usePorts.ts](src/usePorts.ts) — what is listening, what is forwarded, and revoking it.
- [src/usePublic.ts](src/usePublic.ts) — the `public/` folder as a served surface.
- [src/extension.ts](src/extension.ts) — activation, `fallback: true`, and why none of these is a rail tile.

## How it fits

The panel view is a **fallback**: `fallback: true` means the registry drops its activation for a repo another
view already claims, so a repo with a real first-party surface gets that instead of a raw iframe.

Ports and Public are **Sandbox hub tabs**, not rail tiles. Both answer "what can the outside reach" — Ports while
something is running, Public with nothing running — which is a fact about the box, alongside Status and Access.
The everyday path to a dev server is already elsewhere: Ctrl+clicking the localhost URL a terminal printed
forwards and opens it. The rail carries only the EXPOSURE signal — an indicator that appears exactly while a port
is forwarded, the way a VPN shield does.

## Conventions & gotchas

- Everything in `public/` is served to anyone with the link, with no sign-in. The view says so where it matters;
  the directory not existing means nothing is published.
