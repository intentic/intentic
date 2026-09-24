# sandbox-contract

The wire contract between the editor and the sandbox daemon: every route, its schemas and its access policy, as one oRPC contract both ends compile against.

```mermaid
flowchart LR
    web["Editor<br/>typed oRPC client"] --> contract(["sandboxContract"])
    ext["Extensions<br/>api.sandbox.rpc"] --> contract
    contract --> daemon["Sandbox daemon<br/>route factories"]
    daemon -- "device · webext<br/>runner contracts" --> peers["Machines · browser extension<br/>runners"]
    contract -. "contract.lock.json" .-> shrink["contract-shrink<br/>push gate"]
    contract -. "generated from" .-> openapi["sandbox-openapi"]
```

- Each subject pairs a route group in `src/contracts/*.contract.ts` with its wire shapes in `src/schemas/`.
  `src/index.ts` assembles them into `sandboxContract`, which the daemon implements per domain and the browser calls
  through one typed client.
- Policy sits beside each route: `procedure()` declares how a request authenticates, which member tier it needs and how
  far a control token reaches. Routes outside oRPC (streams, WebSocket upgrades, `/health`) are listed in
  `RAW_ROUTES`.
- Three contracts run the other way. `deviceContract`, `webextContract` and `runnerContract` are served by a user's
  machine, the browser extension and a runner over the socket each one opens, with the daemon as the client.
- The daemon names the routes it implements on the `/events` hello frame, and the browser diffs that list against its
  own build, so a route an older daemon lacks shows as a missing feature instead of a 404.
- `contract.lock.json` is every exported schema as canonical JSON Schema. `pnpm verify:turn` rewrites it, and
  `_tools/checks/contract-shrink.mjs` refuses a push that shrinks it unless a commit declares the break (`type!:` or
  `Breaking-Note:`).

## Key files

- [src/index.ts](src/index.ts) — `sandboxContract`, the route tables derived from it, and every public export.
- [src/protocol/route-meta.ts](src/protocol/route-meta.ts) — the per-route policy fields and their defaults.
- [src/protocol/raw-routes.ts](src/protocol/raw-routes.ts) — every route the daemon serves outside oRPC.
- [src/protocol/routes.ts](src/protocol/routes.ts) — route naming, `streamOf` for streamed routes, and the route list a daemon advertises.
- [contract.lock.json](contract.lock.json) — the committed fingerprint of the wire surface.
- [src/webext/index.ts](src/webext/index.ts) — a narrow entry point, one of several that keep small bundles off the barrel.

## Commands

```sh
pnpm --filter @intentic/sandbox-contract lock   # rebuild, then rewrite contract.lock.json
pnpm --filter @intentic/sandbox-contract test
```
