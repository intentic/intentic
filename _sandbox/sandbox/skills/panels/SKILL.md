---
name: panels
description: Give a repository an operator panel, a small web UI (dev server) the user opens from the sidebar to run and preview that repo. Every git repo under /work is a sidebar entry; a repo gets a panel by adding an `operator/` directory that is a runnable web app. Use whenever you scaffold or work in a repo the user should be able to open, preview, or operate from the sidebar.
---

# Operator panels (per-repository)

The user's workspace sidebar lists every git repository under `/work`. Clicking one opens that
repo's **operator panel**: a live web UI served from inside the sandbox and previewed in an iframe at
`https://preview-<repo>-<sandboxId>.<zone>`, with hot reload. There is **no manifest file** (no apps.json /
scripts.json): a repo has a panel purely by convention.

## Convention

A repository exposes a panel when it has an **`operator/` directory at its root** that is a runnable web app:

- `<repo>/operator/package.json` with a **`dev` script**.
- The dev server MUST honor the **`PORT`** environment variable: the daemon assigns a free port at start and
  injects it. Do not hardcode a port.
- Bind `0.0.0.0` only if the framework defaults to localhost-only; the proxy connects over 127.0.0.1.

The daemon runs `pnpm dev` in `operator/` when the user starts the panel, and routes
`preview-<repo>-<sandboxId>.<zone>` to it. The repo name is part of the preview subdomain, so keep repo names
DNS-safe: lowercase letters, digits and hyphens only, at most 42 characters.

## Rules that make previews work

- The preview proxy forwards the request's Host header (`preview-<repo>-<sandboxId>.<zone>`) unchanged. Dev servers that
  validate hosts must allow it, for Vite (and Astro): `server: { allowedHosts: true }` (or list the host).
  HMR websockets are proxied too.
- Preview URLs are PUBLIC (no sign-in in front of them): do not serve secrets on them.
- The panel is a normal web app: install its own deps in `operator/` (its `package.json`).

## Talking to the daemon from a panel

A panel's own backend can call the sandbox daemon (workspace files, git, inventory, …) without any browser
login: the daemon injects two env vars into the panel process:

- `INTENTIC_DAEMON`: the daemon base URL (e.g. `http://127.0.0.1:8787`).
- `INTENTIC_PANEL_TOKEN`: send it as the `x-intentic-panel` request header; the daemon accepts it in place of
  a Google bearer. Keep it server-side (never expose it to the panel's browser code).

Processes are not persisted: after a sandbox restart panels are stopped until started again from the sidebar.

## Handing a panel (or any small web app) over as ONE file

A preview URL needs the sandbox running. When the user wants to *keep* or *send* a small app — a report with
interactive charts, a calculator, a prototype — build it into a single self-contained HTML file: no server, no
CDN, opens from disk anywhere. For a Vite app:

```sh
pnpm add -D vite-plugin-singlefile
```

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
export default defineConfig({ plugins: [/* your framework plugin, */ viteSingleFile()] });
```

`pnpm build` then writes `dist/index.html` with every script, style and small asset inlined. Check it the
honest way — open it with the browser tools from `file://` and look — and hand it over by path, or copy it
under `public/` **only** when a link was asked for, saying plainly that `public/` is served on the open
internet. Fonts and images referenced by URL still leave; inline them (base64) or use system fonts if the
file must work offline. A framework that cannot build to static (a server-rendered app) cannot be handed over
this way; say so rather than shipping a file that only works next to its server.
