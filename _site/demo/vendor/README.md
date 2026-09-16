# vendor

The listed first-party extensions the demo runs, at the commits the registry pins. Nothing here is written by hand.

- `extensions.json`: the pins, one `{ repo, sha }` per extension id. The sha is the registry's listing for that
  extension; moving a listing means moving the pin.
- `extensions/<id>/`: that extension's manifest and built UI bundle, fetched by `scripts/sync-extensions.mjs` before
  every build and **gitignored**: the fixture lists them as installed extensions and serves the bundle exactly as a
  daemon would, so the demo exercises the real install path rather than a compiled-in copy.
- `knowledge/`: the fs-free half of the knowledge engine as source, **committed** so the fixture that stands in for
  its backend type-checks with nothing fetched. A generated copy with its origin in every file's first line, refreshed
  by the same sync.

```sh
pnpm sync                                   # from GitHub at the pins
pnpm sync -- --local ../../../extensions    # from local checkouts while an extension is being changed
```
