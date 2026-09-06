# @intentic/sandbox-openapi

The daemon's wire contract as an OpenAPI 3.1 document, generated from the contract rather than written beside
it.

A hand-kept spec is a second source of truth that is wrong the day after it is written. This package derives
the document from `@intentic/sandbox-contract` — the same oRPC routes and zod schemas the daemon serves and
the editor calls — so a route that changes shape changes the document in the same commit, and a route that
nobody exposed cannot appear in it at all. What it adds on top of the contract is the part the contract has no
opinion about: how operations are grouped for a reader, and what each one needs to be allowed to do.

## Key files

- [`src/spec.ts`](src/spec.ts) — the document itself: every route walked into a path item, with the operation
  ids, request bodies and responses an OpenAPI reader expects.
- [`src/converter.ts`](src/converter.ts) — zod → JSON Schema, in the dialect oRPC's own generator declares, so
  a schema means the same thing on both sides of the conversion.
- [`src/groups.ts`](src/groups.ts) — the shelves and tags a reader meets the surface through, which is the one
  editorial decision here.
- [`src/security.ts`](src/security.ts) — which control-token scope each operation sits behind, derived from the
  contract's own scope ladder.
