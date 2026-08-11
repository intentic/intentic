# @intentic/vscode

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
The shipped default is the engine bundle at `engine/main.cjs`, assembled at release (not yet wired).

- `pnpm build` — bundle the extension host code (esbuild → `dist/extension.cjs`) and typecheck.
- `pnpm build:app` — copy the web build into `media/app` (build `@intentic-app/web` first).
- `pnpm test` — the pure cores: webview document derivation, the engine env contract, JSONC.

## Key files

- [src/extension.ts](src/extension.ts) — activation: engine up, panels registered, theme watched.
- [src/engine.ts](src/engine.ts) — engine lifecycle: free port, spawn, health gate, output channel, dispose.
- [src/panels.ts](src/panels.ts) — the three surfaces as webviews; the live theme post.
- [src/appHtml.ts](src/appHtml.ts) / [src/engineEnv.ts](src/engineEnv.ts) — the two pure contracts, tested.
