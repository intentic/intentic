# First-party extensions

The intentic app is a **lean core + an extension system** (the VSCode bet). This directory holds the
first-party extensions — real, in-repo extension packages that dogfood the same public
[`@intentic/extension-api`](../_libs/extension-api) a third-party bundle would use. See the extension system
in [ARCHITECTURE.md](../ARCHITECTURE.md) for how the host loads and gates them.

## What an extension is

A package with an `intentic-extension.json` manifest at its root and (for UI extensions) an `activate(api,
context)` that registers contributions — `views`, `viewers`, `commands`, `settings` on the UI side;
`processes`, `agent`, `environment`, `connectors`, `listener`, `bin` on the daemon/agent side. The manifest
is the approval + gating surface: the host refuses any registration the approved manifest never declared, and
the extension may reach only the daemon routes its `permissions.sandbox` allowlist declares.

Dependencies are limited **by lint** (`.oxlintrc.json`, scoped to `_extensions/**`) to
`@intentic/extension-api`, `@intentic/extension-ui`, and `@intentic/sandbox-contract`. Reaching into
`@intentic-app/*` or the app internals is a boundary violation and fails the build.

## The extensions

| Extension | Kind | What it contributes |
| --- | --- | --- |
| `acceptance` | UI view | Every repo's `docs/user-stories` + their acceptance criteria, authored here and walked through the running app by agents driving real browsers (one isolated fleet session per story, screenshots + report, live watchable). |
| `activity` | UI view | The agent activity feed. |
| `repo-apps` | UI view | Per-repo apps: preview URLs, add/start/stop, vitest. |
| `automations` | UI view | Cron / webhook / listener automations. |
| `logs` | UI view | Workspace log tail. |
| `memory` | UI view | The agent's persistent memory notes: review, edit, delete. |
| `pipelines` | UI view | CI runs: status, rerun/cancel, agent-driven fixes. |
| `preview` | UI view | Per-repo dev-server preview panels. |
| `viewers` | UI viewers | File renderers (docx / xlsx / svg) via `contributes.viewers`. |
| `connectors` | data-only | CLI-tool connectors as manifest data — no code. |
| `discord` | daemon gateway | A `process` + `listener` bridging Discord to the daemon, plus the discord connector. |
| `imap` | daemon gateway | A `process` + `listener` watching an IMAP mailbox (new-mail / flags / expunge wakes), plus the imap connector. |
| `rtk` | environment fragment | Ships the rtk binary into the sandbox image overlay (output-filter benchmarking); git-install opt-in. |

## How they load — three paths, one list

Every extension below is enumerated by
[installedExtensions()](../_apps/sandbox/src/extensions/installed-extensions.ts) and served by
`GET /extensions`, whatever its code's origin — that single list is what the Sandbox hub's Extensions tab
renders and what the on/off switch acts on. The paths differ only in where the *code* comes from:

- **Compiled into the web bundle** (the UI extensions): statically imported into
  [_apps/web/src/extension-host/builtins.ts](../_apps/web/src/extension-host/builtins.ts), keyed by manifest
  id, and activated at shell boot through the same manifest-gated host as any other extension. Their
  `intentic-extension.json` is baked into the image beside the daemon-side ones, so the daemon lists them
  even though it runs none of their code. Adding a new first-party UI extension = a new package here + one
  entry there + one `COPY` in the Dockerfile; miss the last and the tab shows the extension as `unlisted`,
  miss the middle one and it shows as `missing`. (Note the three *core* view contributions in
  `_apps/web/src/core-views/coreViews.ts` are **not** extensions — they're privileged in-app views coupled to
  platform internals; see that file and ARCHITECTURE.md.)
- **Baked into the sandbox image** (`connectors`, `discord`, `imap`): the whole checkout copied to
  `/opt/extensions` by the sandbox [Dockerfile](../_apps/sandbox/Dockerfile) and read via `EXTENSIONS_DIR` —
  present in every sandbox, `builtin: true` on `GET /extensions`, not removable, no capability entry. This is
  how connector capability cards exist out of the box.
- **Git-installed** (the `extension` capability): an owner-only, full-sha-pinned clone into
  `.intentic/extensions/<id>` — the path for third-party extensions and for opt-in first-party ones like
  `rtk` (its environment fragment composes per capability entry, so baking it would be inert).

## Switching one off

`POST /extensions/{id}/enabled` records the owner's choice in `.intentic/extension-enablement.json`, keyed by
`publisher.name` so it outlives a remove/re-add. A disabled extension stays **listed** (that is what keeps its
switch reachable) and drops out of `enabledExtensions()`, which every consumer that actually wires something
up iterates: no agent plugin dir, no PATH entry, no listener provider, no connector card, no contributed env
var, no autoStart process. In the browser the loader retires its activation, so its views, viewers, commands
and file bindings unwind without a reload.

Not everything converges at the same moment, and the tab says which per extension: `views`, `viewers`,
`commands`, `files`, `processes`, `connectors`, `listener` and `settings` are immediate; `agent` and `bin` are
composed per agent turn, so they apply from the next one; an `environment` fragment only changes on the next
image rebuild.

The current split is a **UI veneer**: an extension is mostly where its Vue lives, while feature backends
still sit in the daemon core. Moving those behind a daemon-side extension runtime is a deliberately deferred,
marketplace-phase step.
