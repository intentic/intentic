# First-party extensions

The intentic app is a **lean core + an extension system** (the VSCode bet). This directory holds the
first-party extensions — real, in-repo extension packages that dogfood the same public
[`@intentic/extension-api`](../_sandbox/extension-api) a third-party bundle would use. See the extension system
in [ARCHITECTURE.md](../ARCHITECTURE.md) for how the host loads and gates them.

## What an extension is

A package with an `intentic-extension.json` manifest at its root and (for UI extensions) an `activate(api,
context)` that registers contributions — `views`, `viewers`, `commands`, `settings` on the UI side;
`processes`, `agent`, `environment`, `capabilities`, `listener`, `bin` on the daemon/agent side. The manifest
is the approval + gating surface: the host refuses any registration the approved manifest never declared, and
the extension may reach only the daemon routes its `permissions.sandbox` allowlist declares.

Every manifest here also declares a **mark** — a `logo` (simple-icons slug) or an `icon` (a glyph from
`@intentic/ui`'s set) — which is what the extension is drawn as wherever it is *listed* rather than used: the
Extensions tab, a registry being browsed, the public gallery. It is on the manifest rather than on a view
because more than a third of the packs below contribute no view at all, and because a switched-off or
not-yet-installed extension still has to look like something. A pack that declared neither would fall back to
its initials; `extensionMarks.test.ts` in the web app keeps that from happening by accident and checks the
glyph names are real.

Dependencies are limited **by lint** (`.oxlintrc.json`, scoped to `_extensions/**`) to
`@intentic/extension-api`, `@intentic/extension-manifest`, `@intentic/extension-ui`, and
`@intentic/sandbox-contract`. Reaching into `@intentic-app/*` or the app internals is a boundary violation and
fails the build.

**Reach the daemon through `api.sandbox.rpc`**, the contract as a typed client: `rpc.git.stashApply({ repo, ref,
pop })` rather than a hand-built URL, a hand-set method and a hand-declared response shape. The older
`api.sandbox.request`/`json` take a path string and stay only for the routes the contract does not declare
(raw file bytes, chunked upload). Both go through the same `permissions.sandbox` gate, so switching doors
changes nothing about what an extension is allowed to reach — only about how much of the call it has to
restate, and whether a daemon that has moved on is a build error or a silent one.

**Before drawing a control, check whether `api` already owns it.** Some surfaces are the shell's and an
extension only asks for them: `api.terminal`, `api.chat`, `api.documents` — and `api.models`, the app's own
provider/account/harness/model picker, which every run-starting view uses (`api.models.pick` to choose,
`api.models.describe` to name a choice already saved). These are APIs rather than kit components because they
are live reads of what the sandbox has connected, so a control an extension draws itself can only offer a worse
list — the automations form had four rows of chips that could not offer a model endpoint, could not offer an
installed ACP agent, and happily pinned an account with no headroom left. `permissions.conformance.test.ts`
fails any extension that reaches `/{provider}/models` or `/{provider}/accounts` on its own.

## The extensions

| Extension | Kind | What it contributes |
| --- | --- | --- |
| `acceptance` | UI view | Every repo's `docs/user-stories` + their acceptance criteria, authored here and walked through the running app by agents driving real browsers (one isolated fleet session per story, screenshots + report, live watchable). |
| `activity` | UI view | The agent activity feed. |
| `repo-apps` | UI view | Per-repo apps: preview URLs, add/start/stop, vitest. |
| `automations` | UI view | Cron / webhook / listener automations. |
| `documentation` | UI view + agent CLI + plugin | Plain-language architecture docs for every repo and package: a map-first agent run writes them as a reviewable draft, the owner publishes them into the repo. Ships the `intentic-docs` CLI (`contributes.bin`) and the `documenting` skill (`contributes.agent`). |
| `git-history` | UI document | Every repository's commit graph, as an icon on its Workspace tree row: lanes and merges, a commit's changed files, and the write actions on one (branch, tag, checkout, cherry-pick, revert, drop, merge, rebase, reset) — plus the branch switcher. The uncommitted half of the same story stays in the app's Changes panel. |
| `logs` | UI view | Workspace log tail. |
| `maintenance` | UI view | The chore book against this workspace: what routine upkeep each repository is owed (outdated deps, advisories, dead code, duplication, undocumented packages, tangled files, periodic surveys), the daemon-measured evidence behind each verdict, and an isolated fleet turn per chore. |
| `memory` | UI view | The agent's persistent memory notes: review, edit, delete. |
| `pipelines` | UI view | CI runs: status, rerun/cancel, agent-driven fixes. |
| `preview` | UI view | Per-repo dev-server preview panels. |
| `viewers` | UI viewers | **Every file format the app can show that isn't source code** — images, SVG (picture + source), PDF, audio/video (a streaming player over `/workspace/media`), docx, xlsx — via `contributes.viewers`. The core resolves a path to text or to opaque bytes and stops there; switch this off and those files fall back to a download. |
| `connectors` | data-only | CLI-tool connectors as manifest data — no code. |
| `social` | data-only | The platforms the agent acts on **as the owner** through the shared logged-in Chromium (Reddit, X, YouTube): a card, a login URL and a cheatsheet each. The browser itself is core — this pack buys identity, not tooling. |
| `computers` | data-only | The OS skill packs a connected computer installs (Windows PowerShell, Linux shell + Wayland/X11). The tool surface, the enrollment and the scope enforcement are core; only the pack varies. |
| `acp-agents` | data-only | The ACP agents offered as chat providers (OpenCode, Gemini CLI, any custom command) — presets over one config shape. |
| `discord` | daemon gateway | A `process` + `listener` bridging Discord to the daemon, plus the discord connector. |
| `slack` | daemon gateway | A `process` + `listener` bridging Slack to the daemon over Socket Mode (outbound WebSocket — no public URL, no request signing), plus the slack connector. Mention replies are painted into the thread live. |
| `telegram` | daemon gateway | A `process` + `listener` bridging Telegram to the daemon over long polling (outbound HTTPS — no public URL, no webhook), plus the telegram connector. Dependency-free: the Bot API is `fetch` and JSON. Replies are painted into the chat live. |
| `whatsapp` | daemon gateway | A `process` + `listener` bridging WhatsApp to the daemon as a paired **linked device** (baileys, outbound WebSocket), plus the whatsapp connector and the agent's `whatsapp` CLI (`contributes.bin`). Unofficial by nature — the card says so and asks for a dedicated number. Replies send once, complete, behind a typing indicator; the pairing code rides the status route onto the capability card. |
| `imap` | daemon gateway | A `process` + `listener` watching an IMAP mailbox (new-mail / flags / expunge wakes), plus the imap connector. |
| `rtk` | environment fragment | Ships the rtk binary into the sandbox image overlay (output-filter benchmarking); git-install opt-in. |

## How they load — four paths, one list

Every extension below is enumerated by
[installedExtensions()](../_sandbox/sandbox/src/extensions/installed-extensions.ts) and served by
`GET /extensions`, whatever its code's origin — that single list is what the Sandbox hub's Extensions tab
renders and what the on/off switch acts on. The paths differ only in where the *code* comes from:

- **Compiled into the web bundle** (the UI extensions): statically imported into
  [_editor/web/src/extension-host/builtins.ts](../_editor/web/src/extension-host/builtins.ts), keyed by manifest
  id, and activated at shell boot through the same manifest-gated host as any other extension. Their
  `intentic-extension.json` is baked into the image beside the daemon-side ones, so the daemon lists them
  even though it runs none of their code. Adding a new first-party UI extension = a new package here + one
  entry there + one `COPY` in the Dockerfile; miss the last and the tab shows the extension as `unlisted`,
  miss the middle one and it shows as `missing`. (Note the three *core* view contributions in
  `_editor/web/src/core-views/coreViews.ts` are **not** extensions — they're privileged in-app views coupled to
  platform internals; see that file and ARCHITECTURE.md.)
- **Baked into the sandbox image** (`connectors`, `social`, `computers`, `acp-agents`, `discord`, `slack`,
  `telegram`, `whatsapp`, `imap`): the whole checkout copied to `/opt/extensions` by the sandbox
  [Dockerfile](../_sandbox/sandbox/Dockerfile) and read via `EXTENSIONS_DIR` — present in every sandbox,
  `builtin: true` on `GET /extensions`, not removable, no capability entry. This is how the `/capabilities`
  grid's derived cards exist out of the box — and why switching one of these packs off removes exactly its
  cards and nothing else.
- **Git-installed** (the `extension` capability): an owner-only, full-sha-pinned clone into
  `.intentic/extensions/<id>` — the path for third-party extensions and for opt-in first-party ones like
  `rtk` (its environment fragment composes per capability entry, so baking it would be inert).
- **Workspace** (none in this directory — they are not first-party by definition): a directory per extension
  under `.intentic/workspace-extensions/`, consumed in place with no clone and no install moment — the path
  for extensions authored *inside* the sandbox, typically by an agent with its own file tools. `.intentic` is
  shared across sessions, so an extension written from an isolated worktree is live for the daemon at once,
  and an edit to its UI entry is a new bundle identity (the bundle route ETags the bytes, not a commit).
  Because nothing install-shaped ever rejects one, a directory that fails to enumerate — no manifest, a
  manifest that doesn't parse, an id a baked or installed extension already owns — is *reported* on
  `GET /extensions` (`invalid`) and rendered by the tab, rather than silently skipped. A workspace extension
  that proves out graduates by moving to a real repo and being git-installed; its id and its
  enablement/settings keys survive the move, since both derive from the manifest.

## Switching one off

`POST /extensions/{id}/enabled` records the owner's choice in `.intentic/extension-enablement.json`, keyed by
`publisher.name` so it outlives a remove/re-add. A disabled extension stays **listed** (that is what keeps its
switch reachable) and drops out of `enabledExtensions()`, which every consumer that actually wires something
up iterates: no agent plugin dir, no PATH entry, no listener provider, no connector card, no contributed env
var, no autoStart process. In the browser the loader retires its activation, so its views, viewers, commands
and file bindings unwind without a reload.

Not everything converges at the same moment, and the tab says which per extension: `views`, `viewers`,
`commands`, `files`, `processes`, `capabilities`, `listener` and `settings` are immediate; `agent` and `bin` are
composed per agent turn, so they apply from the next one; an `environment` fragment only changes on the next
image rebuild.

The current split is a **UI veneer**: an extension is mostly where its Vue lives, while feature backends
still sit in the daemon core. Moving those behind a daemon-side extension runtime is a deliberately deferred,
marketplace-phase step.
