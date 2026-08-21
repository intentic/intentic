# @intentic/extension-api

The one SDK an extension programs against: the extension-author contract for the intentic app.

One of the packages an extension may depend on, with `@intentic/extension-manifest`,
`@intentic/extension-ui` and `@intentic/sandbox-contract`. Published to npm; it must stay free of app
internals. See the extension system in [ARCHITECTURE.md](../../ARCHITECTURE.md) for how the host loads and
gates extensions.

It **does** name `@intentic/sandbox-contract` types, and that is deliberate: `api.sandbox.rpc` is the daemon's
own contract as a typed client, which is the whole reason an extension no longer has to build a URL to reach
it. The dependency is type-only, so nothing of the contract lands in an extension's runtime. This used to be
forbidden: the contract imported the manifest schema from here, so depending back would have closed a cycle.
`@intentic/extension-manifest` exists to break exactly that, and its README has the reasoning.

## What's here

- **[api.ts](src/api.ts)**: `IntenticApi`, the host surface delivered to `activate(api, context)`. There is
  no ambient global; everything an extension registers is a `Disposable` pushed onto
  `context.subscriptions`, so deactivation unwinds it. `api.sandbox.rpc` is the typed daemon client, gated by
  the manifest's `permissions.sandbox` allowlist exactly as the older `request`/`json` doors are.
- **The manifest schema lives in [@intentic/extension-manifest](../extension-manifest)**, not here: it is what
  an extension *declares*, and the daemon needs it without needing any of this package. The manifest is the
  **approval + gating surface**: the install dialog shows exactly the declared contribution points, and the host
  refuses any runtime registration (view, command, viewer, setting, process…) the approved manifest never
  declared. Contribution points: `views`, `files`, `viewers`, `documents`, `commands`, `settings`,
  `processes`, `agent`, `environment`, `capabilities`, `listener`, `automationTemplates`, `bin`, plus the
  `permissions.sandbox` route allowlist. That list is not prose to be kept in sync by hand:
  `surface-guard.test.ts` reads it back out of this file and fails when it stops matching the schema.
  Every one of those points carries its own description, generated out to
  [an authoring schema](https://intentic.dev/intentic-extension.schema.json); point a manifest's `$schema` at
  it and an editor completes the fields, explains what each does, and marks a key nothing declares.
  A `listener` owns both halves of its public vocabulary: labelled event types for daemon validation and the
  source/filter/starter wording a generic automation editor renders. Installing a listener therefore adds a
  configurable automation source without an app release or a second provider table.
  `automationTemplates` is the other half of that bargain: the starting points for a pack's own service:
  trigger, prompt, guard, setup instructions: declared by whoever knows the service rather than written into
  the automations surface. Both fold into one catalogue the daemon serves (`GET /automations/catalog`), which
  is also what `POST /automations` validates against, so the editor cannot offer a trigger the daemon refuses.
  Identity is derived, never declared: `extensionIdOf(manifest) = ${publisher}.${name}`.
- **[facts.ts](src/facts.ts)**: the stable **detection** vocabulary (`RepoFacts`, `CapabilityFacts`) a
  view's `detect()` reads to decide when to activate. This is *not* the data plane.
- **[server.ts](src/server.ts)**: `ExtensionServerApi`, the BACKEND half's surface. A manifest `server`
  bundle exports `activateServer(api, context)` and runs in the daemon's backend host (one separate
  supervised process shared by every enabled backend); `api.routes.mount` serves the extension's own
  `/x/<id>/…` namespace, `api.daemon.request/json` reaches the daemon's routes under the manifest's
  `permissions.daemon` allowlist, and workspace files are plain `node:fs` under `api.workspaceRoot`: full
  trust, so paths rather than a file service. The extension's own namespace needs no `permissions.sandbox`
  entry on the UI side: its backend is its own.

Three surfaces, at three different grains, and the grain is what picks one. A **view** activates per *repo*
off the facts (`rail`, `directory`, `sandbox`). A **viewer** takes over a *file extension*. A **document**
answers per *directory*: `detect(path)` marks the rows it can explain in the Workspace tree, and the host
opens the provider's component as a tab beside the code. A monorepo is one repo with fifty-five documented
packages, which is exactly the case a per-repo `detect()` cannot express. An offer that is EVIDENCE about the
directory rather than an affordance every directory of its kind has says so (`evidence: true`), and the tree
keeps its icon on the row instead of revealing it on hover: the difference between a reader seeing which
packages have a page and a reader having to go looking for one.
- **[scope.ts](src/scope.ts)**, `sandboxRef` and `sandboxScopeGuard`: how an extension keeps state that
  belongs to ONE sandbox. See "Where state lives" below; this is the rule most easily got wrong, because
  getting it wrong looks fine until somebody switches sandbox.
- **[background.ts](src/background.ts)**, `sandboxPoll` and `sandboxLedger`: the work an extension does while
  none of it is on screen. A tile that badges has to be filled by something, and what has already been seen has
  to be written down somewhere; both were hand-written in six extensions before they were here.
- **[stream.ts](src/stream.ts)**, **[version.ts](src/version.ts)**: SSE/ndjson helpers and the host API
  version (`engines.intentic` is checked against it before activation).

Version 2 makes listener contributions self-describing (`events` + `automation`); version 1 listeners only
declared bare event ids and cannot describe a generic editor. Version 2.1 adds the backend half: the
manifest `server` bundle and `permissions.daemon`, additively: a 2.0 manifest is a 2.1 manifest that ships
no backend.

## The data plane

An extension talks to the daemon over `api.sandbox.request/json(path)`: an authenticated transport (auth is
injected host-side; the bundle never sees a token). **Its reach is not unrestricted:** every path is matched
against the extension's manifest `permissions.sandbox` allowlist and an undeclared route throws. Responses
are `sandbox-contract` schemas, parsed at the call site (`Schema.parse(await api.sandbox.json(path))`): the
in-repo, compiled-together design means a wire change is a compiler error fixed atomically, so there is no
separate "stable data API" to promote. `facts.ts` stays the stable surface only for *detection*.

## Where state lives

Three tiers, and the tier decides what happens when the user points the browser at a **different sandbox**.
Everything an extension holds is about one workspace, so a switch has to leave nothing of the last one behind.

- **Cached reads**: `useQuery` in a view, or `api.sandbox.fetch(query)` from outside one. Key them with
  `api.sandbox.key(...)` and the switch is handled by construction: the key carries the active sandbox id, so
  the next box is a different cache entry. Use the *same* key for a view's query and for the badge poll that
  warms it, and the poll's answer becomes the view's first paint.
- **State inside a mounted component**: an ordinary `ref` in a `.vue` file. Nothing to do; it dies with the
  component.
- **Module state owned by `activate()`**: the badge counts, presence maps and poll results that must survive
  the view being unmounted, because a badge you only see after opening the view is pointless. Declare it with
  `sandboxRef(() => initial)` and the host empties it on every switch. There is no subscription to remember
  and no teardown to write; `dispose` is there for state that owns an object URL or anything else the garbage
  collector will not take back.

For anything asynchronous in that third tier, take a `sandboxScopeGuard()` **before** the await and ask it
**after**: a poll issued against the last sandbox otherwise resolves a moment later and writes its answer
into the new one, which is the same wrong badge with a harder repro. It matters twice over for a call that
WRITES: acknowledging what a badge has shown, in the wrong workspace's tree, is bookkeeping no later poll
corrects.

## Keeping a tile current while nothing is mounted

Most of that third tier exists to feed a rail badge, so `sandboxPoll` covers the whole shape and you should not
need `sandboxRef` directly for one:

```ts
const { state: unseen, start } = sandboxPoll<readonly Finding[]>({
    host,                       // your hostSlot's accessor — nothing is bound until activate()
    everyMs: 60_000,            // no default: the right interval is a claim about how fast the answer moves
    initial: () => [],
    read: async (api) => findings(await api.sandbox.fetch(query())),
});
```

`start()` returns the `Disposable` to push onto `context.subscriptions`; `refresh()` reads off-cycle for the
moments that should not wait out the interval. The five rules a hand-written version has to remember: never
reject, skip an unreachable daemon, discard an answer that outlived its sandbox, keep the last good value on
failure, stop the clock on disposal, are the poll's, not yours. Pass `immediate: false` if there is nothing
worth asking until something else tells you what to ask about, and read `previous` in `read` if a round
accumulates onto what you already hold rather than replacing it.

What the tile SAYS stays yours: `badge()` is the judgement each surface exists to make, and no two of them
agree about tone or wording.

`sandboxLedger(host, path)` is the other half: the JSON file recording what the owner has already seen, as
`key → mark`, where the mark is what makes an entry stale. Compare marks (a chore's evidence digest, a story's
verdict) and the same key with new evidence is news again; ignore them and it is a plain presence ledger. It
reads a missing or mangled file as "nothing acknowledged", writes nothing when nothing moved, and holds the
scope guard across its own read-then-write so an acknowledgement cannot land in the wrong workspace's tree.

This is not advice. `sandboxScope.guard.test.ts` in the app walks each extension's UI entry through its own
imports and refuses module-level `ref`/`shallowRef`/`reactive`, any reassignable module binding, and any
repeating clock in what it reaches, because the failure it prevents was found in six extensions at once: a
rail tile reading `21` under a workspace that had two.

## Authoring an extension

`activate(api, context)` registers contributions and returns; `deactivate` is optional. A UI extension also
ships a prebuilt single-file ESM `entry` bundle (built with `vue` and `@intentic/extension-api` external).
The five UI extensions under [`_extensions/`](../../_extensions) are the working templates; start from one.

## Key files

- [src/api.ts](src/api.ts): the handle an extension is given; the centre of this package.
- [src/facts.ts](src/facts.ts): the public facts a view's `detect()` answers from.
- [src/engines.ts](src/engines.ts): how `engines.intentic` is matched against the version below, for the host
  and the daemon alike.
- [src/route.ts](src/route.ts): the query rules a view with internal navigation uses.
- [src/scope.ts](src/scope.ts): module state that belongs to one sandbox, and the guard for work in flight
  across a switch.
- [src/version.ts](src/version.ts) and [src/surface.json](src/surface.json): the protocol version, and what
  each version of it promised.

The manifest schema and the `permissions.sandbox` matcher are **not here**: they moved to
[@intentic/extension-manifest](../extension-manifest), which exists so the daemon can read a manifest without
depending on the browser-facing API.
