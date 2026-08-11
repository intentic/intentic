# @intentic/extension-api

The one SDK an extension programs against — the extension-author contract for the intentic app.

One of the packages an extension may depend on, with `@intentic/extension-manifest`,
`@intentic/extension-ui` and `@intentic/sandbox-contract`. Published to npm; it must stay free of app
internals. See the extension system in [ARCHITECTURE.md](../../ARCHITECTURE.md) for how the host loads and
gates extensions.

It **does** name `@intentic/sandbox-contract` types, and that is deliberate: `api.sandbox.rpc` is the daemon's
own contract as a typed client, which is the whole reason an extension no longer has to build a URL to reach
it. The dependency is type-only, so nothing of the contract lands in an extension's runtime. This used to be
forbidden — the contract imported the manifest schema from here, so depending back would have closed a cycle.
`@intentic/extension-manifest` exists to break exactly that, and its README has the reasoning.

## What's here

- **[api.ts](src/api.ts)** — `IntenticApi`, the host surface delivered to `activate(api, context)`. There is
  no ambient global; everything an extension registers is a `Disposable` pushed onto
  `context.subscriptions`, so deactivation unwinds it. `api.sandbox.rpc` is the typed daemon client, gated by
  the manifest's `permissions.sandbox` allowlist exactly as the older `request`/`json` doors are.
- **The manifest schema lives in [@intentic/extension-manifest](../extension-manifest)**, not here — it is what
  an extension *declares*, and the daemon needs it without needing any of this package. The manifest is the
  **approval + gating surface**: the install dialog shows exactly the declared contribution points, and the host
  refuses any runtime registration (view, command, viewer, setting, process…) the approved manifest never
  declared. Contribution points: `views`, `files`, `viewers`, `documents`, `commands`, `settings`,
  `processes`, `agent`, `environment`, `capabilities`, `listener`, `automationTemplates`, `bin`, plus the
  `permissions.sandbox` route allowlist. That list is not prose to be kept in sync by hand —
  `surface-guard.test.ts` reads it back out of this file and fails when it stops matching the schema.
  A `listener` owns both halves of its public vocabulary: labelled event types for daemon validation and the
  source/filter/starter wording a generic automation editor renders. Installing a listener therefore adds a
  configurable automation source without an app release or a second provider table.
  `automationTemplates` is the other half of that bargain: the starting points for a pack's own service —
  trigger, prompt, guard, setup instructions — declared by whoever knows the service rather than written into
  the automations surface. Both fold into one catalogue the daemon serves (`GET /automations/catalog`), which
  is also what `POST /automations` validates against, so the editor cannot offer a trigger the daemon refuses.
  Identity is derived, never declared — `extensionIdOf(manifest) = ${publisher}.${name}`.
- **[facts.ts](src/facts.ts)** — the stable **detection** vocabulary (`RepoFacts`, `CapabilityFacts`) a
  view's `detect()` reads to decide when to activate. This is *not* the data plane.
- **[server.ts](src/server.ts)** — `ExtensionServerApi`, the BACKEND half's surface. A manifest `server`
  bundle exports `activateServer(api, context)` and runs in the daemon's backend host (one separate
  supervised process shared by every enabled backend); `api.routes.mount` serves the extension's own
  `/x/<id>/…` namespace, `api.daemon.request/json` reaches the daemon's routes under the manifest's
  `permissions.daemon` allowlist, and workspace files are plain `node:fs` under `api.workspaceRoot` — full
  trust, so paths rather than a file service. The extension's own namespace needs no `permissions.sandbox`
  entry on the UI side: its backend is its own.

Three surfaces, at three different grains, and the grain is what picks one. A **view** activates per *repo*
off the facts (`rail`, `directory`, `sandbox`). A **viewer** takes over a *file extension*. A **document**
answers per *directory* — `detect(path)` marks the rows it can explain in the Workspace tree, and the host
opens the provider's component as a tab beside the code. A monorepo is one repo with fifty-five documented
packages, which is exactly the case a per-repo `detect()` cannot express. An offer that is EVIDENCE about the
directory rather than an affordance every directory of its kind has says so (`evidence: true`), and the tree
keeps its icon on the row instead of revealing it on hover — the difference between a reader seeing which
packages have a page and a reader having to go looking for one.
- **[stream.ts](src/stream.ts)**, **[version.ts](src/version.ts)** — SSE/ndjson helpers and the host API
  version (`engines.intentic` is checked against it before activation).

Version 2 makes listener contributions self-describing (`events` + `automation`); version 1 listeners only
declared bare event ids and cannot describe a generic editor. Version 2.1 adds the backend half — the
manifest `server` bundle and `permissions.daemon` — additively: a 2.0 manifest is a 2.1 manifest that ships
no backend.

## The data plane

An extension talks to the daemon over `api.sandbox.request/json(path)` — an authenticated transport (auth is
injected host-side; the bundle never sees a token). **Its reach is not unrestricted:** every path is matched
against the extension's manifest `permissions.sandbox` allowlist and an undeclared route throws. Responses
are `sandbox-contract` schemas, parsed at the call site (`Schema.parse(await api.sandbox.json(path))`) — the
in-repo, compiled-together design means a wire change is a compiler error fixed atomically, so there is no
separate "stable data API" to promote. `facts.ts` stays the stable surface only for *detection*.

## Authoring an extension

`activate(api, context)` registers contributions and returns; `deactivate` is optional. A UI extension also
ships a prebuilt single-file ESM `entry` bundle (built with `vue` and `@intentic/extension-api` external).
The five UI extensions under [`_extensions/`](../../_extensions) are the working templates; start from one.

## Key files

- [src/api.ts](src/api.ts) — the handle an extension is given; the centre of this package.
- [src/facts.ts](src/facts.ts) — the public facts a view's `detect()` answers from.
- [src/engines.ts](src/engines.ts) — how `engines.intentic` is matched against the version below, for the host
  and the daemon alike.
- [src/route.ts](src/route.ts) — the query rules a view with internal navigation uses.
- [src/version.ts](src/version.ts) and [src/surface.json](src/surface.json) — the protocol version, and what
  each version of it promised.

The manifest schema and the `permissions.sandbox` matcher are **not here** — they moved to
[@intentic/extension-manifest](../extension-manifest), which exists so the daemon can read a manifest without
depending on the browser-facing API.
