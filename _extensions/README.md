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
| `agent-activity` | UI view | The agent activity feed. |
| `apps` | UI view | Per-repo apps: preview URLs, add/start/stop, vitest. |
| `automations` | UI view | Cron / webhook / listener automations. |
| `logs` | UI view | Workspace log tail. |
| `preview` | UI view | Per-repo dev-server preview panels. |
| `viewers` | UI viewers | File renderers (docx / xlsx / svg) via `contributes.viewers`. |
| `connectors` | data-only | CLI-tool connectors as manifest data — no code. |
| `discord` | daemon gateway | A `process` + `listener` bridging Discord to the daemon, plus the discord connector. |
| `rtk` | environment fragment | Ships the rtk binary into the sandbox image overlay (output-filter benchmarking); git-install opt-in. |

## How they load — three paths

- **Compiled into the web bundle** (the UI extensions): statically imported and activated at shell boot
  through the manifest-gated host in
  [_apps/web/src/extension-host/builtins.ts](../_apps/web/src/extension-host/builtins.ts). Adding a new
  first-party UI extension = a new package here + one line there. (Note the three *core* view contributions
  in `_apps/web/src/extensions/builtins.ts` are **not** extensions — they're privileged in-app views coupled
  to platform internals; see that file and ARCHITECTURE.md.)
- **Baked into the sandbox image** (`connectors`, `discord`): copied to `/opt/extensions` by the sandbox
  [Dockerfile](../_apps/sandbox/Dockerfile) and enumerated via `EXTENSIONS_DIR` by
  [installedExtensions()](../_apps/sandbox/src/extensions/installed-extensions.ts) — present in every
  sandbox, `builtin: true` on `GET /extensions`, not removable, no capability entry. This is how connector
  capability cards exist out of the box.
- **Git-installed** (the `extension` capability): an owner-only, full-sha-pinned clone into
  `.intentic/extensions/<id>` — the path for third-party extensions and for opt-in first-party ones like
  `rtk` (its environment fragment composes per capability entry, so baking it would be inert).

The current split is a **UI veneer**: an extension is mostly where its Vue lives, while feature backends
still sit in the daemon core. Moving those behind a daemon-side extension runtime is a deliberately deferred,
marketplace-phase step.
