# intentic (the VSCode extension)

The **VSCode extension** — intentic's chat, agents board, and AI accounts inside the editor, over an engine
running in its **local profile** on the user's own machine. No sandbox, no platform, no sign-in: the person
at the keyboard is the owner, and agents work directly on the folder the window has open.

## How it hangs together

Three existing pieces, hosted rather than rebuilt:

- **The engine** is `@intentic/sandbox` in its local profile (its `platform/profile.ts` has the contract):
  spawned as a child process on a free loopback port when a folder opens, killed with the window — agents
  pause with the editor and resume where they stood. Its history and the provider-credential store live under
  the extension's global storage ([src/engineEnv.ts](src/engineEnv.ts) pins the whole env contract);
  credentials are shared across workspaces on purpose — connecting Claude once is connecting it everywhere.
- **The panels** load `@intentic-app/web`'s own build (copied into `media/app` by
  [scripts/copy-app.mjs](scripts/copy-app.mjs)) in its **local posture**: chat as the activity-bar view
  (context retained, so a streaming turn rides a sidebar switch), the agents board and accounts as editor
  tabs. The webview document is derived from the build's index.html by the pure
  [src/appHtml.ts](src/appHtml.ts) — asset URLs onto the webview scheme, the deployed env script replaced by
  an inline local-posture declaration, and a CSP whose only outbound hole is the loopback engine.
- **The theme** follows the editor: [src/theme.ts](src/theme.ts) resolves the active color theme's full
  document (label → contributed theme file → `include` chain, JSONC tolerated by
  [src/jsonc.ts](src/jsonc.ts)) and hands it to the app's host-theme channel, at load and on every switch.

## Development

The engine command is overridable (`intentic.engine.command` + `intentic.engine.cwd`) so a checkout runs
engine source (`["pnpm", "exec", "tsx", "src/main.ts"]` from `_sandbox/sandbox`) without any packaging step.
The shipped default is the assembled engine tree at `engine/` (entry `engine/dist/main.js`).

- `pnpm build` — bundle the extension host code (esbuild → `dist/extension.cjs`) and typecheck.
- `pnpm build:app` — copy the web build into `media/app` (build `@intentic-app/web` first).
- `pnpm test` — the pure cores: webview document derivation, the engine env contract, JSONC.

## Releasing

`.github/workflows/vscode-publish.yml` runs at every `v*` tag semantic-release pushes — the same trigger as
the npm publish, and like it, *dispatched* rather than triggered by the tag. GitHub starts no workflow from an
event the built-in token created, so the release job dispatches both against the new tag once semantic-release
returns (`_tools/scripts/dispatch-publish.sh`); the workflows still read their version off the ref, exactly as
a tag push would have given it. It calls `_tools/scripts/publish-vscode.sh`, which for each target runs
`_tools/scripts/build-vscode-extension.sh`: build the closure, deploy the daemon as `engine/` (hoisted
layout — vsce cannot package pnpm's symlink forest), prune what the local profile can never use (the
vendored Codex CLI, the onnx runtimes, foreign node-pty prebuilds), **smoke-boot the assembled engine**
(/health must answer with the local profile — a .vsix that would not start never reaches a marketplace), and
pack one platform-specific .vsix per target into `dist-bin/`.

`@types/vscode` is the one dependency here that is pinned literally rather than taken from the workspace
catalog: vsce semver-parses the specifier *string* it finds in this manifest, so a `catalog:` there fails the
pack outright ("Failed to parse semver of @types/vscode"). It also may not outrun `engines.vscode` — the two
are one decision, the minimum VS Code host this extension supports, and move together.

Publishing is gated on secrets and skips loudly without them, so the release train never fails over this
artifact: `VSCE_PAT` (Azure DevOps PAT, Marketplace ▸ Manage, publisher `intentic` — creating that publisher
is a one-time manual step) gates the Visual Studio Marketplace, `OVSX_PAT` gates Open VSX. Tokenless runs
still build and upload the .vsix files as a workflow artifact — installable by hand with
`code --install-extension`. The package is named bare `intentic` (a marketplace extension ID is
`publisher.name` and cannot carry an npm scope), so CI's verify-core names it in its own filter.

## Key files

- [src/extension.ts](src/extension.ts) — activation: engine up, panels registered, theme watched.
- [src/engine.ts](src/engine.ts) — engine lifecycle: free port, spawn, health gate, output channel, dispose.
- [src/panels.ts](src/panels.ts) — the three surfaces as webviews; the live theme post.
- [src/appHtml.ts](src/appHtml.ts) / [src/engineEnv.ts](src/engineEnv.ts) — the two pure contracts, tested.
