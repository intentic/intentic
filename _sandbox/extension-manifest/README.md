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

## Key files

- [src/manifest.ts](src/manifest.ts) — the `intentic-extension.json` schema. The manifest is the **approval +
  gating surface**: the install dialog shows exactly the declared contribution points, and the host refuses any
  runtime registration the approved manifest never declared.
- [src/permissions.ts](src/permissions.ts) — `sandboxRouteAllowed`, the `"<METHOD> <path-glob>"` matcher behind
  `permissions.sandbox`. Kept beside the schema because it is the rule for one of the schema's own fields.

## Conventions & gotchas

- **Declaration only.** If something here needed to know how the host behaves, it would belong in
  `extension-api` instead. The test is whether the daemon — which has no host and no browser — still needs it.
- The contribution-point list in the schema is read back by the host's surface guard, which compares it against
  `extension-api`'s recorded surface and its README — so adding a contribution point here without bumping the
  SDK version there fails that test rather than shipping a version number that lies about what it supports.
