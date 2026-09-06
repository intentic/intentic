# The bundled deployment engine

Intent → needs → desired state → reconcile: a standalone infrastructure tool that ships in this monorepo and
is not part of the product.

## The intent-driven flow

```
Intent ──► NeedResolver ──► Needs ──► StateResolver ──► desired state ──► Execute ──► (reads true)
```

1. **Intent** (a declaration authored with the SDK: `i.have.*` (the inventory you bring) read, never
   created or destroyed: `host`, `cloudflare`, `github`, `gitlab`, `backup`, `discord`, `stripe`) and
   `i.want.*` (what intentic owns end-to-end, created, reconciled, pruned, destroyed: `app`, `service`,
   `workspace`, `database`, `cache`, `auth`, `objectStorage`, `user`, `team`), each
   app wired to its host/Cloudflare via `on` / `expose`. Captured as a serializable `IntentSet`.
   ([_deploy/sdk/src/stack.ts](../../_deploy/sdk/src/stack.ts))
2. **Need resolver**, derives the abstract capabilities the intent requires: `source-control`,
   `docker-registry`, `infra-control` (control plane), `deployment-target`, `domain` (application plane).
   (`resolveNeeds` in [_deploy/need-resolver/src/needs.ts](../../_deploy/need-resolver/src/needs.ts))
3. **State resolver**: assigns each need its catalog option and compiles the emitted nodes into one
   **desired state** (a `DesiredStateGraph`). The catalog maps capabilities to the concrete things that
   satisfy them; one option may cover several (Forgejo provides both source-control and docker-registry).
   `catalogFor(intent)` selects the source control: `i.have.github` ⇒ GitHub (GHCR + Actions),
   `i.have.gitlab` ⇒ GitLab (its registry + CI), otherwise the self-hosted Forgejo default. **Komodo is
   unconditional**: on every stack CI only builds and pushes the image and Komodo rolls it out, so no
   host SSH credential ever reaches a hosted forge and the host stays outbound-only. The intent fully
   determines the result: within the selected catalog there is exactly one option per capability, so
   resolution stays deterministic. (`resolveState` in
   [_deploy/state-resolver/src/state.ts](../../_deploy/state-resolver/src/state.ts), over `catalogFor` in
   [catalog.ts](../../_deploy/state-resolver/src/lib/catalog.ts) and the nodes emitted by
   [emit.ts](../../_deploy/state-resolver/src/emit/emit.ts))
4. **Execute**: apply the desired state and re-read it, looping until a plan reads all-noop ("state reads
   true"). (`reconcile` in [_deploy/engine/src/reconcile/reconcile-loop.ts](../../_deploy/engine/src/reconcile/reconcile-loop.ts), over
   `apply`/`plan` and the Provider SPI)
5. **Prune**, after convergence, deletion converges too, from two sources: the baseline diff (resources in
   the last-applied artifact the new one no longer declares) and the **collection scan**: each provider's
   `list` enumerates its live stamped resources (`intentic.id` / `intentic.type` labels, stamped DNS-record
   comments) and everything absent from the graph is an orphan, pruned without needing any baseline.
   Deletions require `apply --yes` (pending ones are previewed otherwise), nodes with a `protect: true`
   input (stateful backings by default) are never deleted, and `intentic deploy destroy --yes` is the same prune
   against the empty graph. Drift detection is also stamp-based: every resource carries an `intentic.hash`
   of its serialized inputs, and a mismatch reads as an update regardless of the provider's own diff.
   (`prune`/`pruneOrphans` in [prune.ts](../../_deploy/engine/src/reconcile/prune.ts), `collectOrphans` in
   [orphans.ts](../../_deploy/engine/src/reconcile/orphans.ts), stamps in [stamp.ts](../../_deploy/graph/src/stamp.ts))

A `DesiredStateGraph` is the central data structure: a serializable, dependency-ordered set of resource
nodes with refs, secrets, and readiness gates. ([_deploy/graph/src/types.ts](../../_deploy/graph/src/types.ts))

## Output contract (driving the CLI as a service)

The engine separates two seams on `EngineConfig`: `log` carries providers' free-form strings, and
`onEvent` emits structured `EngineEvent`s for lifecycle progress: `node` (apply/plan, start/done with
the action), `readiness`, `iteration`, `prune`, and `orphan`
([types.ts](../../_deploy/engine/src/types.ts)). The CLI selects a renderer from `INTENTIC_OUTPUT`
(`text` | `json` | `ndjson`) in [output.ts](../../_deploy/cli/src/lib/output.ts): `text` is the human default
(unchanged), `json` serializes the command's returned outcome once, and `ndjson` streams each event as
a line then a terminal `result`. The final result is built from the engine's return values
(`PlanOutcome`/`ConvergeResult`/`PruneOutcome` and `collectAccess`), never from events: so a control
plane gets both live progress and a parseable summary, and embedders consume `EngineEvent` directly.


## The intent contract

A local `deploy.config.ts` (see [_tools/examples/deploy.config.ts](../../_tools/examples/deploy.config.ts)) must
`export const intent = defineIntent(...)`; `resolve` derives the desired state from it
([resolve.ts](../../_deploy/cli/src/resolve/resolve.ts)). `defineStack(...)` is the one-shot,
single-graph form used when a single deterministic graph is wanted directly.


## Demo

`pnpm demo:up` / `demo:down` / `demo:clear` ([_deploy/cli/src/demo.ts](../../_deploy/cli/src/demo.ts)) drive the
real CLI (`init`/`resolve`/`apply`) against a Docker-in-Docker "host", standing up Forgejo + Komodo behind
a Cloudflare tunnel so the result can be browsed. It is a **maintainer tool**, not a zero-setup demo: it
provisions against a real Cloudflare zone (`CLOUDFLARE_ZONE`, default `intentic.dev`) using
`CLOUDFLARE_API_TOKEN`, and shares the tunnel name `intentic-host` with the e2e harness (don't run both at
once).

- **`demo:up`** boots the privileged host (SSH on `DEMO_SSH_PORT`, default 2222), scaffolds with
  `init --link`, runs resolve + apply, seeds a test app, and leaves everything running: printing the
  public URLs (`git.<zone>` / `deploy.<zone>` / `app.<zone>`), the local URLs, and the generated admin
  logins. State is persisted in `.demo/state.json` so teardown can always find what it created.
- **`demo:down`** stops the host container but leaves the Cloudflare tunnel + DNS in place, so the next
  `demo:up` reconnects in seconds.
- **`demo:clear`** also purges the tunnel + DNS records the demo created.
