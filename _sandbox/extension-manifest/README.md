# @intentic/extension-manifest

What an extension **declares** — as opposed to what it programs against.

This package holds the `intentic-extension.json` schema and the rule that matches a daemon call against the
manifest's `permissions.sandbox` allowlist. Nothing else: no host API, no Vue, no runtime behaviour. It imports
zod and nothing more.

## Why it is its own package

It exists to break a cycle. The daemon's wire contract (`@intentic/sandbox-contract`) has to validate manifests,
because the daemon serves extension listings and gates installs — so it needs the schema. The host API
(`@intentic/extension-api`) has to name the daemon's typed client, because that is what an extension calls the
sandbox through — so it needs the contract. With the schema living in `extension-api`, those two requirements
formed a loop, and the loop is why `api.sandbox` could only ever offer `request(path)` and `json<T>(path)`: a
string-shaped door to a fully typed surface, with every extension re-writing the URL, the method and the
response shape by hand.

Splitting the declaration vocabulary out settles it in one direction:

```
extension-manifest  ←  sandbox-contract  ←  extension-api
```

Both of the other packages depend on this one; this one depends on neither. `extension-api` may now name
contract types, which is what lets `api.sandbox.rpc` be typed.

## One point, one file

What a manifest may declare is not one schema — it is thirteen independent ones, and they used to share a file
every feature had to edit to add anything, in two places at once. Each now lives alone under
[src/points/](src/points), as its key, its shape and **the sentence that explains it to the author**, and
`contributes` is assembled from the set. Adding a contribution point is a file plus a line.

Binding the description to the schema is the part that pays. It used to sit in a `//` comment — read by
maintainers, never by the one person it was written for — so a manifest was written by copying another
extension's and guessing. Worse, zod *strips* what it does not declare rather than refusing it, at every level:
a misspelt `viewers` was not an error, it was a viewer that never appeared, found at install, with the manifest
parsing perfectly. The descriptions now generate out to `intentic-extension.schema.json`, which an editor reads
to give completion, hover documentation and a red squiggle on a key nothing declares.

That schema is **strict where the runtime is lenient**, deliberately. Authoring is where an unknown key is a
typo worth shouting about; runtime is where one is a manifest written for a newer host, which an older daemon
must go on installing with the point it does not understand ignored — otherwise every addition to that list
would be a breaking change.

## Key files

- [src/points/](src/points) — one contribution point per file, and the index that collects them into
  `CONTRIBUTION_POINTS` and assembles `contributes` from it.
- [src/contribution-point.ts](src/contribution-point.ts) — what a point *is*: name, description, schema. The
  reasoning for why the description travels with the schema rather than sitting in a comment.
- [src/manifest.ts](src/manifest.ts) — the envelope: who the extension is, which host it needs, what code it
  ships, how far it may reach. The manifest is the **approval + gating surface**: the install dialog shows
  exactly the declared contribution points, and the host refuses any runtime registration the approved manifest
  never declared.
- [src/json-schema.ts](src/json-schema.ts) — the authoring schema, emitted from those points.
- [src/permissions.ts](src/permissions.ts) — `sandboxRouteAllowed`, the `"<METHOD> <path-glob>"` matcher behind
  `permissions.sandbox`. Kept beside the schema because it is the rule for one of the schema's own fields.

## Conventions & gotchas

- **Declaration only.** If something here needed to know how the host behaves, it would belong in
  `extension-api` instead. The test is whether the daemon — which has no host and no browser — still needs it.
- The contribution-point list is read back by the host's surface guard, which compares it against
  `extension-api`'s recorded surface and its README — so adding a contribution point here without bumping the
  SDK version there fails that test rather than shipping a version number that lies about what it supports.
- **The generated schema is committed, in two copies** — the one shipped in this package and the one the site
  serves at the `$schema` URL. Run `pnpm --filter @intentic/extension-manifest schema` after touching a point
  and commit both; `manifest-schema.test.ts` regenerates and compares, the way `contract.lock.json` is guarded.
  A generated document only guards anything if a diff shows it moving.
- Points are collected in an explicit list rather than by a module-load side effect. Two committed documents
  are generated from them — that schema and the wire contract's lock — and a registry that filled itself as
  modules happened to load would make both depend on import order.
