# First-party extensions

The intentic app is a **lean core + an extension system** (the VSCode bet). This directory holds the
first-party extensions: real, in-repo extension packages that dogfood the same public
[`@intentic/extension-api`](../_sandbox/extension-api) a third-party bundle would use. See the extension system
in [ARCHITECTURE.md](../ARCHITECTURE.md) for how the host loads and gates them.

## What an extension is

A package with an `intentic-extension.json` manifest at its root and (for UI extensions) an `activate(api,
context)` that registers contributions: `views`, `viewers`, `commands`, `settings` on the UI side;
`processes`, `agent`, `environment`, `capabilities`, `listener`, `bin` on the daemon/agent side. The manifest
is the approval + gating surface: the host refuses any registration the approved manifest never declared, and
the extension may reach only the daemon routes its `permissions.sandbox` allowlist declares.

An extension may also ship a **backend**: a manifest `server` entry naming a prebuilt self-contained node ESM
bundle exporting `activateServer(api, context)`. Every enabled backend runs in the daemon's ONE supervised
backend host process and serves its own route namespace, `/x/<id>/…`, proxied by the daemon through its
ordinary auth. The extension's UI calls its own namespace with no `permissions.sandbox` entry (its backend is
its own code from the same approved checkout); the backend's reach back into the daemon's routes is the
`permissions.daemon` allowlist, enforced with a minted per-extension token. A toggle, an install, or an edit
to a workspace extension restarts the host: loaded code cannot be unloaded, so the restart IS the reload.

Every manifest here also declares a **mark**: a `logo` (simple-icons slug) or an `icon` (a glyph from
`@intentic/ui`'s set), which is what the extension is drawn as wherever it is *listed* rather than used: the
Extensions tab, a registry being browsed, the public gallery. It is on the manifest rather than on a view
because more than a third of the packs below contribute no view at all, and because a switched-off or
not-yet-installed extension still has to look like something. A pack that declared neither would fall back to
its initials; `extensionMarks.test.ts` in the web app keeps that from happening by accident and checks the
glyph names are real.

Dependencies are limited **by lint** (`.oxlintrc.json`, scoped to `_extensions/**`) to
`@intentic/extension-api`, `@intentic/extension-manifest`, `@intentic/extension-ui`,
`@intentic/connector-runtime` (the gateway-process half of the SDK, for the messaging connectors), and
`@intentic/sandbox-contract`. Reaching into `@intentic-app/*` or the app internals is a boundary violation and
fails the build.

**Reach the daemon through `api.sandbox.rpc`**, the contract as a typed client: `rpc.git.stashApply({ repo, ref,
pop })` rather than a hand-built URL, a hand-set method and a hand-declared response shape. The older
`api.sandbox.request`/`json` take a path string and stay only for the routes the contract does not declare
(raw file bytes, chunked upload). Both go through the same `permissions.sandbox` gate, so switching doors
changes nothing about what an extension is allowed to reach: only about how much of the call it has to
restate, and whether a daemon that has moved on is a build error or a silent one.

**Before drawing a control, check whether `api` already owns it.** Some surfaces are the shell's and an
extension only asks for them: `api.terminal`, `api.chat`, `api.documents`, and `api.models`, the app's own
provider/account/harness/model picker, which every run-starting view uses (`api.models.pick` to choose,
`api.models.describe` to name a choice already saved). These are APIs rather than kit components because they
are live reads of what the sandbox has connected, so a control an extension draws itself can only offer a worse
list: the automations form had four rows of chips that could not offer a model endpoint, could not offer an
installed ACP agent, and happily pinned an account with no headroom left. `permissions.conformance.test.ts`
fails any extension that reaches `/{provider}/models` or `/{provider}/accounts` on its own.

**Everything an extension holds belongs to ONE sandbox.** Cached reads are keyed with `api.sandbox.key(...)`
and are handled by that alone. State inside a mounted component dies with the component. What is left is the
module state a badge needs: a count filled by a timer has to outlive the view being unmounted, or it could
only ever tell you what you had already gone and looked at: and that tier is declared with `sandboxRef(() =>
initial)`, which the host empties whenever the browser is pointed at another sandbox. Anything asynchronous
takes a `sandboxScopeGuard()` before its await and asks it after, so a poll that left under the last sandbox
cannot write its answer into the next one.

**A badge is also what puts a rail tile on screen.** The app's rail seats four permanent tiles (Chat, Agents,
Workspace, Preview) and gives every other area a seat only while it is badging, while the reader has pinned it,
or while they are standing in it; the rest are behind the rail's More menu, which lists every area whether or not
it is seated, and each has a `view.*` command in the palette (`core-views/registry.ts` in the web app holds the
rule and the table). So `detect()` decides whether the AREA exists, which is what makes its route, its More row,
its mobile menu row and its palette command work, and `badge()` decides whether it is currently worth a seat. A
view that badges all day therefore does not merely train the reader to stop looking: it holds one of roughly nine
seats while doing it. `ViewBadge`'s bar, something happened here that you don't already know about, is the same
bar as before and now costs something when it is missed.

**Do not hand-write the poll behind a badge.** `sandboxPoll` is that poll, and `sandboxLedger` is the file
recording what the owner has already seen: the two things every badging surface here needed, and six packs
had each written out. What stays yours is the judgement: `badge()` decides the count, the tone and the wording,
and no two of these agree about any of them. A poll takes its interval explicitly, accumulates onto `previous`
when a round adds to what it holds rather than replacing it, and skips its opening read when there is nothing
to ask until something else says what to ask about.

**A badge over a file reacts to the write, not to the clock.** `contributes.files` already told the host which
paths a pack's views derive from, and the host already evicted the query keys it named: what it could not do is
reach state with nothing mounted on it, which is every badge by definition. So the same push is announced
(`api.workspace.onDidChangeFiles`) and `sandboxPoll` wakes on it, which is why the file-backed packs here now
carry interval in the minutes and say in one line that it is a backstop. Four of the six badges in this
directory are file-backed and were each wrong for up to their own interval after the thing they describe had
already landed; the two that are not (Pipelines' CI, Deployments' Komodo) have nothing local to notice, so
their timer is still the whole feed and says so where it is set.

This is not a convention: `sandboxScope.guard.test.ts` in the web app walks each pack's UI entry through its
own imports and refuses module-level `ref`/`shallowRef`/`reactive`, any reassignable module binding, and any
repeating clock in what it reaches. Six packs here had the same omission at once, which is how a Maintenance
tile came to read `21` over a workspace that had two.

## The extensions

| Extension | Kind | What it contributes |
| --- | --- | --- |
| `acceptance` | UI view | Every repo's `docs/user-stories` + their acceptance criteria, authored here and walked through the running app by agents driving real browsers (one isolated fleet session per story, screenshots + report, live watchable). |
| `activity` | UI view | The agent activity feed. |
| `repo-apps` | UI view | Per-repo apps: preview URLs, add/start/stop, vitest. |
| `automations` | UI view | Cron / webhook / listener automations. The SURFACE only: what can wake an agent and what is worth starting from are served together by the daemon's trigger catalogue (`GET /automations/catalog`), its own sources merged with every pack's `contributes.listener` and `contributes.automationTemplates`, and this page names no integration of its own. |
| `deployments` | UI view + backend | Container health, incidents and one-click redeploys over a connected Komodo. Its whole Komodo side (client, board translation, repo→stack links, fix turns) is its backend: the daemon core carries no Komodo feature; the credential is read through the daemon's connection route, declared in `permissions.daemon`. |
| `drafts` | UI view | The approval inbox for posts the agent proposed: approve/edit/reschedule/reject, with the publish engine (store, publisher automation, routes) staying in the daemon. Was an in-app page; the move minted `api.sandbox.role()` and the kit's `BrandMark`/`NoticeStack`/`useNow`/`useAsyncAction`. |
| `documentation` | UI view + agent CLI + plugin | Plain-language architecture docs for every repo and package: a map-first agent run writes them as a reviewable draft, the owner publishes them into the repo. Ships the `intentic-docs` CLI (`contributes.bin`) and the `documenting` skill (`contributes.agent`). |
| `git-history` | UI document | Every repository's commit graph, as an icon on its Workspace tree row: lanes and merges, a commit's changed files, and the write actions on one (branch, tag, checkout, cherry-pick, revert, drop, merge, rebase, reset), plus the branch switcher. The uncommitted half of the same story stays in the app's Changes panel. |
| `knowledge` | UI view + backend + agent CLI + plugin | The owner's knowledge base: a workspace folder of markdown notes that is also a typed graph, `type:` makes a note a thing, a `[[link]]` in a header field is a named relationship. Search, the note, what links to it, and the map around it; its own vocabulary keeps the words consistent without ever refusing a capture. Ships the `kb` CLI (`contributes.bin`, built from the same engine its backend serves) and the `knowledge` skill (`contributes.agent`). |
| `logs` | UI view | Workspace log tail. |
| `maintenance` | UI view | The chore book against this workspace: what routine upkeep each repository is owed (outdated deps, advisories, dead code, duplication, undocumented packages, tangled files, periodic surveys), the daemon-measured evidence behind each verdict, and an isolated fleet turn per chore. |
| `pipelines` | UI view | CI runs: status, rerun/cancel, agent-driven fixes. |
| `preview` | UI view | Per-repo dev-server preview panels. |
| `viewers` | UI viewers | **Every file format the app can show that isn't source code**: images, SVG (picture + source), PDF, audio/video (a streaming player over `/workspace/media`), docx, xlsx, via `contributes.viewers`. The core resolves a path to text or to opaque bytes and stops there; switch this off and those files fall back to a download. |
| `connectors` | data-only | CLI-tool connectors as manifest data: no code. |
| `social` | data-only | The platforms the agent acts on **as the owner** through the shared logged-in Chromium (Reddit, X, YouTube): a card, a login URL and a cheatsheet each. The browser itself is core, this pack buys identity, not tooling. |
| `computers` | data-only | The OS skill packs a connected computer installs (Windows PowerShell, Linux shell + Wayland/X11). The tool surface, the enrollment and the scope enforcement are core; only the pack varies. |
| `acp-agents` | data-only | The ACP agents offered as chat providers (OpenCode, Gemini CLI, any custom command): presets over one config shape. |
| `pi-agent` | data-only + environment fragment | The Pi coding agent as a chat provider under the reserved `pi` id: served by the daemon's own Pi RPC runtime (not ACP), with the image fragment that bakes the Pi CLI in. |
| `discord` | daemon gateway | A `process` + `listener` bridging Discord to the daemon, plus the discord connector. |
| `slack` | daemon gateway | A `process` + `listener` bridging Slack to the daemon over Socket Mode (outbound WebSocket: no public URL, no request signing), plus the slack connector. Mention replies are painted into the thread live. |
| `telegram` | daemon gateway | A `process` + `listener` bridging Telegram to the daemon over long polling (outbound HTTPS, no public URL, no webhook), plus the telegram connector. Dependency-free: the Bot API is `fetch` and JSON. Replies are painted into the chat live. |
| `whatsapp` | daemon gateway | A `process` + `listener` bridging WhatsApp to the daemon as a paired **linked device** (baileys, outbound WebSocket), plus the whatsapp connector and the agent's `whatsapp` CLI (`contributes.bin`). Unofficial by nature: the card says so and asks for a dedicated number. Replies send once, complete, behind a typing indicator; the pairing code rides the status route onto the capability card. |
| `imap` | daemon gateway | A `process` + `listener` watching an IMAP mailbox (new-mail / flags / expunge wakes), plus the imap connector. |
| `google-workspace` | daemon gateway + agent CLI | One connected Google account as Gmail, Calendar, Drive, Docs, Sheets and Contacts: the `gw` CLI (`contributes.bin`), a card that authenticates either as one person (OAuth) or as a whole company (a Workspace service account impersonating a named user), and a `process` + `listener` polling for new mail and imminent events. The read-only setting on the card is enforced twice, narrower scopes at Google, and a per-command refusal here. |
| `rtk` | environment fragment | Ships the rtk binary into the sandbox image overlay (output-filter benchmarking); git-install opt-in. |

## How they load: four paths, one list

Every extension below is enumerated by
[installedExtensions()](../_sandbox/sandbox/src/extensions/installed-extensions.ts) and served by
`GET /extensions`, whatever its code's origin: that single list is what the Sandbox hub's Extensions tab
renders and what the on/off switch acts on. The paths differ only in where the *code* comes from:

- **Compiled into the web bundle** (the UI extensions): statically imported into
  [_editor/web/src/extension-host/builtins.ts](../_editor/web/src/extension-host/builtins.ts), keyed by manifest
  id, and activated at shell boot through the same manifest-gated host as any other extension. Their
  `intentic-extension.json` is baked into the image beside the daemon-side ones, so the daemon lists them
  even though it runs none of their code. Adding a new first-party UI extension = a new package here + one
  entry there + one `COPY` in the Dockerfile; miss the last and the tab shows the extension as `unlisted`,
  miss the middle one and it shows as `missing`. (Note the three *core* view contributions in
  `_editor/web/src/core-views/coreViews.ts` are **not** extensions: they're privileged in-app views coupled to
  platform internals; see that file and ARCHITECTURE.md.)
- **Baked into the sandbox image** (`connectors`, `social`, `computers`, `acp-agents`, `discord`, `slack`,
  `telegram`, `whatsapp`, `imap`, `google-workspace`): the whole checkout copied to `/opt/extensions` by the sandbox
  [Dockerfile](../_sandbox/sandbox/Dockerfile) and read via `EXTENSIONS_DIR`: present in every sandbox,
  `builtin: true` on `GET /extensions`, not removable, no capability entry. This is how the `/capabilities`
  grid's derived cards exist out of the box: and why switching one of these packs off removes exactly its
  cards and nothing else.
- **Git-installed** (the `extension` capability): an owner-only, full-sha-pinned clone into
  `.intentic/local/extensions/<id>`: the path for third-party extensions and for opt-in first-party ones like
  `rtk` (its environment fragment composes per capability entry, so baking it would be inert).
- **Workspace** (none in this directory, they are not first-party by definition): a directory per extension
  under `.intentic/config/workspace-extensions/`, consumed in place with no clone and no install moment: the path
  for extensions authored *inside* the sandbox, typically by an agent with its own file tools. `.intentic` is
  shared across sessions, so an extension written from an isolated worktree is live for the daemon at once,
  and an edit to its UI entry is a new bundle identity (the bundle route ETags the bytes, not a commit).
  Because nothing install-shaped ever rejects one, a directory that fails to enumerate: no manifest, a
  manifest that doesn't parse, an id a baked or installed extension already owns: is *reported* on
  `GET /extensions` (`invalid`) and rendered by the tab, rather than silently skipped. A workspace extension
  that proves out graduates by moving to a real repo and being git-installed; its id and its
  enablement/settings keys survive the move, since both derive from the manifest.

## Switching one off

`POST /extensions/{id}/enabled` records the owner's choice in `.intentic/config/extension-enablement.json`, keyed by
`publisher.name` so it outlives a remove/re-add. A disabled extension stays **listed** (that is what keeps its
switch reachable) and drops out of `enabledExtensions()`, which every consumer that actually wires something
up iterates: no agent plugin dir, no PATH entry, no listener provider, no connector card, no contributed env
var, no autoStart process. In the browser the loader retires its activation, so its views, viewers, commands
and file bindings unwind without a reload.

**Three switches are fixed on**: `automations`, `workflows`, `maintenance` (`ESSENTIAL_EXTENSIONS` in the
daemon). Each is the sole control surface for an engine the daemon runs regardless: the scheduler fires turns
on its own, a running workflow advances daemon-side, the probe runner spends machine time on its tick. "Off"
would not stop any of that: it would only remove the owner's ability to see, stop or approve it, which is how
disabling the automations page once left every cron and approval firing invisibly. The daemon refuses the flip
and the tab draws the switch as fixed with the reason. Declared by the core, never by a manifest: a field an
extension could set on itself would be a pack making itself un-removable. Drafts is deliberately NOT in the
set: its publisher acts only on drafts the owner already approved, so a hidden surface starves that engine
rather than blinding anyone.

Not everything converges at the same moment, and the tab says which per extension: `views`, `viewers`,
`commands`, `files`, `processes`, `capabilities`, `listener` and `settings` are immediate; `agent` and `bin` are
composed per agent turn, so they apply from the next one; an `environment` fragment only changes on the next
image rebuild.

The split is no longer a UI veneer: the backend host gives an extension a server half of its own, and
`deployments` and `knowledge` are the features whose backends live entirely in their packages: own contract,
own routes, no daemon-core feature code. The rest (activity, logs, drafts…) migrate the same way, each
migration deleting its core routes.

## Which way a feature moves: substrate or feature

Not everything migrates out, and getting this backwards is expensive in both directions. The test is whether
**other things plug into it**:

- **A feature** is a surface over its own data that nobody else extends: `deployments`, `knowledge`,
  `acceptance`, `documentation`. Its routes, schemas and translation belong in its package, and the core is
  better off not knowing it exists. These migrate OUT.
- **A substrate** is something other packs fire into or contribute to: the automations trigger bus, the batch
  run engine, the standing-check registry, the CI event source. These stay in the core and publish a
  contribution point, for two reasons. An extension can be switched off, and a bus that stops when someone
  hides a screen is not a bus. And a substrate living in one pack means every other pack that wants to reach it
  either edits that pack or reinvents it: which is exactly what happened while the automations vocabulary lived
  in the automations view, and what three separately-written isolated-run implementations are still evidence of.

The end state is a kernel plus substrates: files/git/watcher, terminals and processes, the agent runtime,
capabilities and their privileged handlers, auth, the extension system: and the cross-cutting buses every pack
is allowed to contribute to.
