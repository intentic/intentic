---
name: panels
description: Make a repository runnable in the sandbox and on the owner's computers (targets in its `.intentic/run.json`, or a Procfile, a dev or start script, a Cargo binary that Start finds) and give it an operator panel, a small web UI the user opens from the sidebar to run and preview that repo, by adding an `operator/` directory that is a runnable web app. Use whenever you scaffold or work in a repo the user should be able to start, open, preview, or operate from the sidebar.
---

# Operator panels (per-repository)

The user's workspace sidebar lists every git repository under `/work`. Clicking one opens that
repo's **operator panel**: a live web UI served from inside the sandbox and previewed in an iframe at
`https://preview-<repo>-<sandboxId>.<zone>`, with hot reload.

## One file for where it runs: `.intentic/run.json`

A repository says what it runs, and where, in `.intentic/run.json`. The owner sees it as one **Run** dialog (the ▷ on
the repo's row in the file tree, or "Run on a computer…" in Browsers): **where** is picked once, the sandbox beside each
connected computer, then each target is one row with one Run.

```json
{
  "targets": [
    { "name": "web", "description": "The shop", "command": "pnpm dev" },
    { "name": "api", "command": "pnpm --filter api dev", "env": { "WEB_ORIGIN": "{previewUrl:web}" } },
    { "name": "desktop", "device": "my-pc", "build": "cargo xwin build --release --target x86_64-pc-windows-msvc",
      "artifact": "target/x86_64-pc-windows-msvc/release/app.exe" }
  ]
}
```

- **`command`: runs in the sandbox**, from the repo root, with `PORT` and the desktop's `DISPLAY` (below). Each such
  target is its own app, `preview-<repo>--<name>-<sandboxId>.<zone>`, with its own Start and Stop in Browsers, so
  several run side by side; its name is lowercase letters, digits and dashes. An `env` value `{previewUrl:<target>}` is
  a sibling's preview address, which is how a web app finds its API. A Node repo installs first.
- **`artifact`: runs on one of the owner's computers**: `build` here, carry the artifact, start it there (the device
  skill; `devices run <target>` is the same run an agent types).
- A target with both runs in either place.

Write a target whenever the owner should be able to run something with one press. Once the file has a sandbox target,
Browsers shows those targets instead of the repository's own Start.

A project kept at the workspace root itself (`/work` is its repository, with no repository folder around it) keeps its
file at `/work/.intentic/run.json`, beside the sandbox's own state. Its commands run from `/work`. The editor calls that
repository `root`: its ▷ is on the Files toolbar, since the root has no row in the tree, and its targets show in Browsers
as `root--<name>`. The root repository tracks this one file, so an agent's edit lands like code. Don't move the file
into a subfolder: a folder that isn't a repository of its own is never offered a Run.

## What Start finds without one

With no sandbox target in `.intentic/run.json`, the repository's own Start runs the first of these it has (the daemon's `/opt/sandbox/dist/panels/run-plan.js`, in every sandbox;
`_sandbox/sandbox/src/panels/run-plan.ts` where the intentic source is checked out):

1. A **`Procfile`** at the repo root, one `name: command` line per process, as Heroku and foreman read it. The `web`
   entry (or the only one) gets `PORT`; the others run beside it with `PORT` unset, and stop when it stops.
2. **`operator/package.json`** with a **`dev` script**: a panel kept beside the repo's code.
3. The root **`package.json`**'s `dev` script, else its `start` script.
4. A **`Cargo.toml`** with exactly one binary cargo can pick: `cargo run` (with `-p`/`--bin` for a workspace with one
   binary member, or the package's own binary out of several). Several binary members and no `default-members` is a
   choice the repo makes itself, with a Procfile.

Node runs install first when `node_modules` is missing (`pnpm install`); a Cargo run builds as it starts. A repo with
none of these lists with **Make it startable**, which asks an agent to declare its run in `.intentic/run.json`.

For a web app:

- The dev server MUST honor the **`PORT`** environment variable: the daemon assigns a free port at start and
  injects it. Do not hardcode a port.
- Bind `0.0.0.0` only if the framework defaults to localhost-only; the proxy connects over 127.0.0.1.

Every run is also handed the **sandbox desktop's `DISPLAY`**, so a game or a desktop app opens its window there; the
panel shows that window instead of a preview (it must set `_NET_WM_PID`, as winit, SDL, GTK and Qt do). Nothing
declares which a run is: a port that answers makes it a preview, a window makes it a desktop app.

The daemon routes `preview-<repo>-<sandboxId>.<zone>` to the assigned port. The repo name is part of the preview
subdomain, so keep repo names DNS-safe: lowercase letters, digits and hyphens only, at most 42 characters.

## Rules that make previews work

- The preview proxy forwards the request's Host header (`preview-<repo>-<sandboxId>.<zone>`) unchanged. Dev servers that
  validate hosts must allow it, for Vite (and Astro): `server: { allowedHosts: true }` (or list the host).
  HMR websockets are proxied too.
- Preview URLs are PUBLIC (no sign-in in front of them): do not serve secrets on them.
- The panel is a normal web app: install its own deps in `operator/` (its `package.json`).
- **Declare `color-scheme` on the page.** The browser draws the scrollbar, the form controls and the canvas
  under a transparent page from the PAGE's own declaration: a framed page inherits neither the editor's around
  it nor the reader's OS preference. A dark panel that declares nothing gets the light-mode scrollbar in the
  preview — a pale bar down the side of a dark app. One line, in the panel's own stylesheet:

  ```css
  html { color-scheme: dark; } /* or `light`, or `light dark` for a page that follows the reader */
  ```

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
