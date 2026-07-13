# @intentic-app/web

The **Vue 3 SPA** (Vite + PrimeVue) — the platform's workspace UI. A user signs in with Google, connects a sandbox, and then drives that sandbox's daemon **directly** over its own Cloudflare tunnel (authenticated by a Google ID token): chat with the Claude agent, browse the workspace, edit inventory, run infra plan/provision, and view topology + deployments. The platform API it talks to is thin — only sign-in (Better Auth) + the `setup.*` handshake (mint token, store the sandbox's URL); everything else is browser→sandbox-direct. Talks to [`@intentic-app/api`](../api) via the oRPC client + to the sandbox daemon via `sandboxRequest`; shares types through [`@intentic-app/api-contract`](../../_libs/api-contract) and primitives through [`@intentic-app/ui`](../../_libs/ui). Dev server (Vite) on :47145; the SPA calls the API directly at `API_URL` (`https://localhost:6480` in dev, CORS-enabled) — the base URL comes from the runtime `window.env` in [src/environments](src/environments), not relative paths.

## Responsibilities

- Render the post-login workspace shell, the page areas, and the persistent chat panel.
- Hold client state in composables (module-level `ref` singletons); fetch request/response data via **TanStack `@tanstack/vue-query`**; talk to the **platform** via the typed oRPC client (sign-in + `setup.connect`) and to the **sandbox daemon directly** via `sandboxRequest` (a Bearer Google ID token, no cookies); consume the daemon's SSE/ndjson streams manually.
- Drive auth (Google sign-in via Better Auth), the setup gate, and the browser-direct workspace surface (chat, infra, inventory, deployments).

## Layout

- **[src/composables/](src/composables)** — module-level singletons + vue-query wrappers:
  - `useAuth.ts` — Better Auth session, Google sign-in/out, Stripe plan/upgrade. Guards live in the router.
  - `useApi.ts` — the oRPC `ContractRouterClient` singleton; the platform surface is just `setup.*` (+ `me`).
  - `useSandbox.ts` — the browser's sandbox state: `daemonUrl` (from `setup.binding`) + `reachable` (the live SSE probe in `useSandboxLiveness.ts`); the browser alone judges liveness.
  - `useGoogleIdentity.ts` — Google Identity Services: mints/caches the ID token the daemon verifies.
  - `sandboxClient.ts` — the browser→daemon-direct client (`sandboxRequest`/`sandboxJson`/`sandboxBlob`): calls `${daemonUrl}${path}` with `Authorization: Bearer <Google ID token>`.
  - `useChat.ts` + `conversation.ts` — the Claude agent, daemon-direct (`/agent`, `/agent/decision`, `/agent/answer`, `/sessions`, `/claude/*`).
  - `useDeployments.ts` / `useWorkspaceState.ts` (+ `workspaceStateProjection.ts`) / `useInventory.ts` / `useWorkspaceTree.ts` — the read-model + inventory as **vue-query** queries/mutations against the daemon; `intenticStream.ts` is the shared `/intentic` ndjson reader; `renderMarkdown.ts` sanitizes marked output (DOMPurify) for `v-html`.
  - `useLayout.ts` — chat panel + explorer sidebar width/side.
- **[src/layout/](src/layout)** — the persistent shell: `WorkspaceShell.vue` (rail | workspace | chat grid), `ChatPanel.vue`, `AccountPanel.vue`, `GoogleSigninGate.vue`.
- **[src/pages/](src/pages)** — lazy-loaded areas: `Login`, `Setup`, `Sandbox`, `Infra` (topology + config/provision), `workspace/` (VSCode-like explorer + file viewer), and the `*Dialog.vue` overlays.
- **[src/router/index.ts](src/router/index.ts)** — `/login` + `/setup` → guarded shell (`/`) with child areas; `beforeEnter` guards (`requireAuth`, `requireSetup`) replace the old route guards.

## Conventions

- **`<script setup lang="ts">` SFCs**; state in `ref`/`computed`; shared state in composables (no Pinia). PrimeVue imported directly from `primevue/*`; register-once bits (theme, tooltip) via `installUi`.
- **vue-query for request/response** (`useQuery`/`useMutation`, keyed + refetchable); streaming (chat tokens, sandbox liveness) stays manual with `ref` + `fetch`/`EventSource`.
- PrimeVue components + Tailwind 4 utilities + `@intentic-app/ui` (`Page`, `Card`, `Code`, `InfoHint`, `useTheme`, `useHighlighter`); markdown via `marked` + DOMPurify; code via Shiki (`useHighlighter`).
- **SSE/ndjson consume pattern** (see `conversation.ts` / `intenticStream.ts`): read the `ReadableStream`, split on `\n\n`, take `data:` lines, `JSON.parse` into the event union, fold into refs.

## How to extend

**Default: write an extension, not a shell edit.** A new user-facing feature (a sidebar panel, a file
viewer, a command) is a contribution to the extension system, not a new page baked into the shell. This is
the whole point of the lean-core split — see the extension system in [ARCHITECTURE.md](../../ARCHITECTURE.md).

- **New panel / area:** add a first-party extension under [`_extensions/`](../../_extensions) (a
  `intentic-extension.json` manifest + an `activate` that calls `api.views.register`), and wire it into
  [src/extension-host/builtins.ts](src/extension-host/builtins.ts). It reaches the daemon only through the
  routes its manifest declares, and consumes the shared UI slice via `@intentic/extension-ui`. Start from an
  existing extension (e.g. [`_extensions/logs`](../../_extensions/logs)) as the template.
- **New file viewer:** contribute a `viewers` entry from an extension (see
  [`_extensions/viewers`](../../_extensions/viewers)) — the host owns the fetch and hands your component the
  bytes. Don't add a branch to `FileViewer.vue`.
- **New sandbox call from an extension:** add the daemon route, declare it in the extension's manifest
  route allowlist, then call it via `api.sandbox.json` (validate the response against the
  `@intentic/sandbox-contract` schema). An undeclared route is refused by the host.

**Reserved for core** (edit the shell directly only for these): the editor surfaces themselves
(`WorkspaceTree`, `CodeView`, `FileViewer`, chat), the router/shell scaffolding in `router/index.ts` /
`WorkspaceShell.vue`, and the three privileged core view contributions in
[src/extensions/builtins.ts](src/extensions/builtins.ts) (`infrastructure`, `live-status`, `directory-ui`)
that are coupled to platform/onboarding internals a clean extension must not reach. New client state for a
core surface: a composable exposing a module-level `ref`.
