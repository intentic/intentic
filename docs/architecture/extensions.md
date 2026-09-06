# The extension system

How a feature is added without touching the core: what an extension declares, where its halves run, and what
it may reach.

### Extension system

The app is a **lean core + an extension system**, the same bet VSCode makes. An extension is a package
with an `intentic-extension.json` manifest at its root ([manifest.ts](../../_shared/extension-manifest/src/manifest.ts),
one file per contribution point under [points/](../../_shared/extension-manifest/src/points));
identity is derived, never declared (`extensionIdOf = ${publisher}.${name}`). The manifest is the
**approval + gating surface**: the install dialog shows exactly the declared contribution points, and the
host refuses any runtime registration the approved manifest never declared. Contribution points cover both
UI (`views`, `viewers`, `commands`, `settings`) and daemon/agent surface (`processes`, `agent`,
`environment`, `connectors`, `listener`, `bin`). A UI extension ships a prebuilt ESM `entry` bundle and an
`activate(api, context)` function; there is no ambient global: the host `IntenticApi` arrives as the
`activate` argument, and everything registered is a `Disposable` pushed onto `context.subscriptions` so
deactivation unwinds cleanly ([api.ts](../../_shared/extension-api/src/api.ts)).

Two boundaries are load-bearing and easy to confuse: the distinction is the most important architectural
line in the app:

- **`_editor/web/src/extension-host/`**: the real host. It loads git-installed third-party bundles
  (`GET /extensions` → engines check → authenticated bundle fetch → `import()` → `activate`) and the
  compiled-in first-party extensions ([extension-host/builtins.ts](../../_editor/web/src/extension-host/builtins.ts)),
  **both through the same manifest-gated `createExtensionApi`** ([apiImpl.ts](../../_editor/web/src/extension-host/apiImpl.ts)).
  A builtin extension can touch only the public `IntenticApi`, never app internals: that is the dogfooding
  boundary that keeps the first-party extensions honest.
- **`_editor/web/src/core-views/coreViews.ts`**: three *core* view contributions (`infrastructure`,
  `live-status`, `directory-ui`) that are extension-*shaped* but stay in the app because each is genuinely
  coupled to platform/onboarding or the file-open iframe bridge. They register through the same runtime
  registry but consume privileged internals **by design**, and the file documents exactly why each one
  can't be a clean extension.

The **data plane** an extension talks to is `sandbox-contract` over an authenticated transport
(`api.sandbox.request/json`: auth injected host-side, tokens never seen by the bundle). An extension's
reach into daemon routes is **declared in its manifest and gated by the host**, so coupling is explicit and
reviewable rather than ambient. The narrow `facts.ts` surface
([facts.ts](../../_shared/extension-api/src/facts.ts)) is only the stable **detection** vocabulary a view's
`detect()` reads to decide when to activate: not the data plane. The SDK is published as two npm packages:
[`@intentic/extension-api`](../../_shared/extension-api) (types + manifest schema) and
[`@intentic/extension-ui`](../../_shared/extension-ui) (a host-provided slice of the app design system, resolved at
runtime via an import map so every extension shares the shell's one Vue/PrimeVue instance).

What an extension **bundles** is exactly its declared contributions: a prebuilt ESM `entry` (UI) with
`views` / `viewers` / `commands` / `settings`; `capabilities`: a capability CARD as pure data (catalog card +
config fields, plus per-kind payload: a cli connector's env templates + SKILL.md + optional client-image
fragment, a browser platform's login URL + SKILL.md, a host OS pack's SKILL.md), rendered by the web as a
*derived* capability card and resolved by the daemon's generic handler for that kind: never a handler of its
own (see [Capabilities](#capabilities)); `processes` (daemon-run,
tmux-managed background processes); `agent` (a directory that is a Claude Code plugin:
skills/agents/hooks/.mcp.json, handed to the Agent SDK's plugin loader each turn); `environment` (a
RUN/ENV-only Dockerfile fragment baked into the sandbox image overlay); `bin` (executables prepended to the
agent's PATH); `listener` (a realtime event provider its gateway process implements); and
`permissions.sandbox`, the daemon-route allowlist gating its data plane.

First-party extensions live in `_extensions/` and reach the product by one of **four load paths**: but by
**one list**: every extension, whatever its path, is enumerated by `installedExtensions()`
([installed-extensions.ts](../../_sandbox/sandbox/src/extensions/installed-extensions.ts)) and served by
`GET /extensions`, which is what the Sandbox hub's Extensions tab renders and what the on/off switch acts on.

- **Compiled into the web bundle**: the UI extensions (`acceptance`, `activity`, `automations`, `logs`,
  `pipelines`, `preview`, `repo-apps`, `viewers`), statically imported and keyed by manifest id
  ([extension-host/builtins.ts](../../_editor/web/src/extension-host/builtins.ts)). They ship no `entry` over the
  wire (the bundle IS the SPA) but their manifest is baked into the image beside the daemon-side ones, so
  the daemon lists them and the loader's only question per extension is where its code comes from. The two
  ways image and bundle can disagree are surfaced as states, not silence: `missing` (manifest, no module) and
  `unlisted` (module, no manifest: activated anyway, so the rail survives an older image).
- **Baked into the sandbox image**: the daemon-side ones ship their whole checkout at `/opt/extensions`
  (Dockerfile bake, `EXTENSIONS_DIR`) and are served as `source: "builtin"`, present in every sandbox, not
  removable, no capability entry. Four are pure data and exist to hold the `/capabilities` grid's derived
  cards (`connectors`, `social`, `devices`, `acp-agents`); three ship a gateway process as well (`discord`,
  `slack`, `imap`). This is how those cards exist out of the box, and why switching one of those packs off
  removes exactly its cards.
- **Git-installed**, the `extension` capability: an owner-only, full-sha-pinned clone into
  `.intentic/local/extensions/<id>`, validated before swap. Third-party extensions arrive this way; of the
  first-party ones only `rtk` does, because its environment fragment composes per capability entry.
- **Workspace**, a directory per extension under `.intentic/config/workspace-extensions/`, consumed in place: no
  clone, no capability entry, no install moment. The path for extensions authored *inside* the sandbox,
  typically by an agent with its own file tools: `.intentic/config` is tracked, so one written from an
  isolated worktree rides the agent's branch and reaches the daemon when the turn lands, reviewable in the
  agent's diff like any code, and an edit to its UI entry is simply a new bundle identity (the bundle route
  ETags the bytes rather than a commit). A workspace id can never shadow a baked
  or installed one, and a directory that fails to enumerate: no manifest, a manifest that doesn't parse, a
  taken id, is *reported* on `GET /extensions` (`invalid`) and rendered by the tab: with no install step to
  reject it, the list is the author's feedback channel.

Any of them can be **switched off**: `POST /extensions/{id}/enabled`, recorded in
`.intentic/config/extension-enablement.json` by `publisher.name`. A disabled extension stays listed (that is what
keeps its switch reachable) and drops out of `enabledExtensions()`, which every consumer that wires something
up iterates, so it contributes no agent plugin dir, PATH entry, listener provider, connector card, env var or
autoStart process; the web loader retires its activation in place. `agent` and `bin` are composed per turn and
`environment` only at image rebuild, so those three apply later: the tab states which per extension.

**Extensions are loaded per sandbox, not per page load.** Which extensions exist, which the owner left on and
everything each has read are one sandbox's answers, so switching the active sandbox retires every activation,
empties the extensions' own module state and loads again against the new box's list
([useExtensionHost.ts](../../_editor/web/src/extension-host/useExtensionHost.ts)). That module state is the third
tier of client state and the one with no natural owner: a rail badge has to be filled from state that outlives
its view being unmounted, so every extension that badges keeps a module-level ref and a timer: and until this
existed, none of them let go of it. The primitive is `sandboxRef`
([scope.ts](../../_shared/extension-api/src/scope.ts)), the host empties it, and `sandboxScope.guard.test.ts`
refuses any other way of keeping module state in an extension's browser-side source: a population it finds by
walking each extension's UI entry through its own imports, rather than by a filter over what a file happens to
name. Above that primitive sit the two shapes every badging surface needed and each had written out itself
([background.ts](../../_shared/extension-api/src/background.ts)): `sandboxPoll`, which fills a badge while its view is
unmounted, and `sandboxLedger`, the workspace file recording what the owner has already seen. What a tile SAYS is
deliberately not shared: the count, the tone and the wording are the judgement each surface exists to make. That
poll is driven by the FILE WRITE wherever the answer lives in one: `contributes.files` already named the paths a
view derives from, and the push it produces was spent entirely on evicting query keys, which reaches only a query
something observes and therefore never a badge. The frame is announced as well as consumed
([fileEvents.ts](../../_editor/web/src/extension-host/fileEvents.ts), `api.workspace.onDidChangeFiles`, scoped to the
subscriber's own declaration), so a tile moves with the file instead of at the next tick, and the interval is left
as the backstop for a dropped frame, or as the only feed for a source no watcher can see (a CI provider, a Komodo
server). The shell's own singletons are re-scoped from one place beside it
([sandboxScope.ts](../../_editor/web/src/features/sandbox/client/sandboxScope.ts)); cached reads need neither, since
every key carries the active sandbox id.

**The backend half.** An extension is no longer only where its Vue lives: a manifest `server` entry names a
prebuilt, self-contained node ESM bundle exporting `activateServer(api, context)`
([server.ts](../../_shared/extension-api/src/server.ts)), and the daemon runs every enabled one inside a single
**backend host**: a separate supervised node process
([backend-supervisor.ts](../../_sandbox/sandbox/src/extensions/backend/backend-supervisor.ts),
[backend-host.ts](../../_sandbox/sandbox/src/extensions/backend/backend-host.ts)). A separate process because loaded
code cannot be unloaded: the off switch, an install at a new sha and a live-edited workspace extension all
require the process holding the old code to die, and that process must never be the daemon: so every
lifecycle moment is a debounced host **restart** (a couple of seconds of readable 503s), converged from the
toggle route, the capability install/remove, and the workspace watcher noticing an extension source change.
One shared process, not one per extension: install is owner-only and sha-pinned (full trust), so isolation
between extensions would buy robustness nobody is billed for; a throwing activation is contained to its row
exactly as in the web loader, and the row rides `GET /extensions` (`backend` on the summary).

Each backend owns a **route namespace**: the daemon proxies `/x/<id>/*` to the host, through its ordinary
auth and role floors, minus the caller's credentials: and the host dispatches with the prefix stripped, so
an extension's handler sees the same paths its own contract declares. Both halves of an extension import that
contract from the extension's own package (ext-knowledge's [contract.ts](../../_extensions/knowledge/src/contract.ts)),
which keeps the compiled-together guarantee at the right grain while the CORE contract shrinks by every
feature that moves out. An extension's UI calls its own namespace with **no `permissions.sandbox` entry**
(its backend is its own code from the same approved checkout); any other namespace conforms like a core
route. The backend's reach back into the daemon is `permissions.daemon`: same glob grammar, enforced by a
minted per-extension token (the `x-intentic-extension` grant in [grants.ts](../../_sandbox/sandbox/src/auth/grants.ts)),
deliberately NOT the all-routes panel token. Workspace files it touches directly with `node:fs` under
`api.workspaceRoot`: full trust means no file service in between.

The extracted features are **deployments** and **knowledge**: each one's routes, translation layer and
schemas live entirely in its `_extensions/` package (UI halves compiled into the web bundle as before;
backends baked as `dist/server.js`), and the daemon core carries neither feature at all. Deployments also
exercises the two kernel calls a real feature backend needs: `GET /capabilities/{id}/connection`, a
capability's stored config, secrets included, refused to every signed-in caller so only a declared extension
grant can read it: and `POST /agent` for its one-click fix turns.

**But not everything moves out, and the direction is decided by one question: does anything else plug into it?**

A **feature** is a surface over its own data that nobody else extends: deployments, knowledge, acceptance,
documentation. Its routes, schemas and translation belong in its package and the daemon is better
off not knowing it exists. Those migrate out one by one, each migration deleting its core routes.

A **substrate** is something other extensions fire into or contribute to: the automations trigger bus, the
batch run engine, the standing-check registry, CI as an event source. Those stay in the core and publish a
contribution point instead, for two reasons. An extension can be switched off, and a trigger bus that stops
when someone hides a screen is not a bus. And a substrate that lives inside one extension leaves every other
extension either editing that extension or reinventing it, which is not hypothetical: while the automations
vocabulary lived in the automations *view*, that view carried a hand-written table of CI, Komodo, Sentry,
Stripe, email and the whole chore book, and the daemon carried a second copy of the same list to validate
against. It is now one catalogue the daemon serves ([automations/catalog.ts](../../_sandbox/sandbox/src/automations/catalog.ts)),
merging its own sources with each pack's `contributes.listener` and `contributes.automationTemplates`.

So the end state is a kernel PLUS its substrates: files/git/watcher, terminals and processes, the agent
runtime, capabilities and their privileged handlers, auth, the extension system itself: and the cross-cutting
buses every extension is allowed to contribute to.
