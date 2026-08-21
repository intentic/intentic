# @intentic/ext-deployments

What is actually running on the servers you own, read from a Komodo you already operate.

## Responsibilities

- Show the estate: servers, stacks, deployments, and the state each is in.
- Join a running thing back to the repository it was built from.
- Notice incidents and carry them to the rail as a badge.
- Talk to Komodo itself: the extension ships its own backend, and the daemon core carries no Komodo feature.

## Key files

- [src/contract.ts](src/contract.ts): the extension's OWN wire shapes, imported by both halves so their wire
  cannot drift; zod only, so the web bundle never pulls the route table in.
- [src/server/server.ts](src/server/server.ts): the backend half (`activateServer`), built to `dist/server.js`
  (`pnpm build`) and run by the daemon's backend host. Reads the Komodo credential through the daemon's
  connection route and starts fix turns through `POST /agent`: both declared in `permissions.daemon`.
- [src/server/komodo-client.ts](src/server/komodo-client.ts): the Komodo Core API behind one client shape.
- [src/server/komodo-overview.ts](src/server/komodo-overview.ts): Komodo's vocabulary → the view's, pure and tested.
- [src/server/komodo-repos.ts](src/server/komodo-repos.ts): which workspace repo belongs to which stack.
- [src/server/komodo-store.ts](src/server/komodo-store.ts): seen-timestamps and repo→stack links (its runtime home, `.intentic/local/runtime/extensions/deployments/komodo.json`).
- [src/useDeploymentBoard.ts](src/useDeploymentBoard.ts), the board's data: what is running, where, and how it is doing.
- [src/incidents.ts](src/incidents.ts): what counts as an incident rather than as noise.
- [src/stateVisual.ts](src/stateVisual.ts): one mapping from a state to how it reads, so nothing invents its own colour.
- [src/RepoLinkRow.vue](src/RepoLinkRow.vue): the join from a deployment back to a repo.
- [src/extension.ts](src/extension.ts): activation, and why it is one tile per connection.

## How it fits

Capability-driven, not repo-driven: the same shape as `ext-pipelines`, for the same reason. Gating on the
intent and desired-state repos would mean someone who simply connects a Komodo they already run gets nothing.

**One tile per connection**, not one for the extension: two Komodos are two production estates, and looking at
staging must not silence the other.

## Conventions & gotchas

- This reads an estate; it does not create one. The bundled deployment engine (`intentic deploy`) is a separate
  tool with its own repo layout, and nothing here depends on it.
