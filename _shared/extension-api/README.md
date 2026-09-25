# extension-api

The versioned public API an intentic extension compiles against: `IntenticApi` for its browser half, `ExtensionServerApi` for its backend half, and the helpers both halves share.

```mermaid
flowchart LR
    web["Editor<br/>extension host"] -- "activate(api, context)" --> view["Extension bundle<br/>views · commands"]
    backend["Daemon<br/>backend host"] -- "activateServer(api)" --> server["Server bundle<br/>routes under /x/id"]
    sdk(["extension-api<br/>types · helpers"]) -.-> view
    sdk -.-> server
    loader["Daemon loader"] -- "engines.intentic<br/>vs extensionApiVersion" --> sdk
```

- There is no ambient global. The host hands `IntenticApi` to `activate(api, context)`, and everything registered
  returns a `Disposable`. A manifest's `server` bundle gets `ExtensionServerApi` in a Node process shared by every
  enabled extension, and reaches daemon routes only as far as `permissions.daemon` allows. The browser half reaches
  its own backend through `api.backend`, by a path relative to its namespace, never by spelling `/x/<id>`.
- An extension gives the agent tools one way: `contributes.tools`, served by `api.tools.serve((card) => [...])` in
  the backend. The host owns the MCP transport, each call's deadline and the card lookup, and hands the card's
  settings with every call; the daemon mounts the server into every turn on every runtime. A plugin's `.mcp.json` is
  deprecated, and a cli card's `mcp` is kept one release as an alias.
- This package is published to npm, and its API only grows within a major. `extensionApiVersion` moves
  with every surface change (additive is a minor), and a manifest's `engines.intentic` range is matched against it at
  load, failing closed. The editor's `surface-guard.test.ts` fails when the surface moves without a new entry in
  `src/surface.json`, which records the api's members and, from 2.20.0, a digest of the whole generated manifest
  schema, since a host's parse drops a field it does not know at any depth.
- Helpers every extension needs live here too: sandbox-scoped module state (`sandboxRef`, cleared on every sandbox
  switch), background polling for rail badges, `sandboxLedger` (whose writes reject rather than overwrite a file they
  could not read), `sandboxDocument` (a file of the extension's own read through the `conversions` its shape has had,
  by the contract's `readDocument`, and written with what a newer version of the extension put in it kept; every handle
  on one path shares one write queue), SSE and ndjson stream reading, and the
  payload for `api.workspace.openDiff`.
- Contribution points: `agent`, `automationTemplates`, `bin`, `capabilities`, `commands`, `documents`,
  `environment`, `files`, `listener`, `processes`, `settings`, `tools`, `viewers` and `views`, plus the manifest's top-level
  fields, all read off `CONTRIBUTION_POINTS` in
  [extension-manifest](../extension-manifest/src/points/index.ts).
- `./protocol` exports only the version and the engines matcher, for the daemon, which cannot load the Vue-dependent
  barrel.

## Key files

- [src/api.ts](src/api.ts) — `IntenticApi`, `ExtensionContext` and the module shape a bundle exports.
- [src/server.ts](src/server.ts) — `ExtensionServerApi`, the backend half.
- [src/version.ts](src/version.ts) — `extensionApiVersion` and what each version added.
- [src/surface.json](src/surface.json) — the recorded public surface, per version.
- [src/scope.ts](src/scope.ts) — module state that belongs to one sandbox.
- [src/background.ts](src/background.ts) — `sandboxPoll` and `sandboxLedger` for work done off screen.
