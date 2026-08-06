# @intentic/extension-api

The one SDK an extension programs against — the extension-author contract for the intentic app.

With `@intentic/extension-ui`, one of only two packages an extension may depend on besides
`@intentic/sandbox-contract`. Published to npm; it must stay free of app internals and must **not** pull in
`@intentic/sandbox-contract` (that would invert the boundary). See the extension system in
[ARCHITECTURE.md](../../ARCHITECTURE.md) for how the host loads and gates extensions.

## What's here

- **[manifest.ts](src/manifest.ts)** — the `intentic-extension.json` schema. The manifest is the **approval
  + gating surface**: the install dialog shows exactly the declared contribution points, and the host
  refuses any runtime registration (view, command, viewer, setting, process…) the approved manifest never
  declared. Contribution points: `views`, `files`, `viewers`, `documents`, `commands`, `settings`,
  `processes`, `agent`, `environment`, `capabilities`, `listener`, `bin`, plus the `permissions.sandbox` route
  allowlist. That list is not prose to be kept in sync by hand — `surface-guard.test.ts` reads it back out of
  this file and fails when it stops matching the schema.
  Identity is derived, never declared — `extensionIdOf(manifest) = ${publisher}.${name}`.
- **[api.ts](src/api.ts)** — `IntenticApi`, the host surface delivered to `activate(api, context)`. There is
  no ambient global; everything an extension registers is a `Disposable` pushed onto
  `context.subscriptions`, so deactivation unwinds it.
- **[facts.ts](src/facts.ts)** — the stable **detection** vocabulary (`RepoFacts`, `CapabilityFacts`) a
  view's `detect()` reads to decide when to activate. This is *not* the data plane.

Three surfaces, at three different grains, and the grain is what picks one. A **view** activates per *repo*
off the facts (`rail`, `directory`, `sandbox`). A **viewer** takes over a *file extension*. A **document**
answers per *directory* — `detect(path)` marks the rows it can explain in the Workspace tree, and the host
opens the provider's component as a tab beside the code. A monorepo is one repo with fifty-five documented
packages, which is exactly the case a per-repo `detect()` cannot express.
- **[stream.ts](src/stream.ts)**, **[version.ts](src/version.ts)** — SSE/ndjson helpers and the host API
  version (`engines.intentic` is checked against it before activation).

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
- [src/manifest.ts](src/manifest.ts) — every contribution point, and what declaring one means.
- [src/permissions.ts](src/permissions.ts) — what an extension may reach, and the gate that enforces it.
- [src/facts.ts](src/facts.ts) — the public facts a view's `detect()` answers from.
- [src/route.ts](src/route.ts) — the query rules a view with internal navigation uses.
