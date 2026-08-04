# Architecture

intentic is a **co-piloted specialized-agent workspace**: each agent runs in its own sandbox on hardware
you own, and from a browser you configure its context, supervise its work, and approve the calls that
matter. This document covers the two tiers that *are* the product — a thin **platform** and the per-user
**sandbox** (and the workspace it serves) — plus, in clearly-marked sections, the **bundled deployment
engine**: a standalone infra tool that ships in this monorepo and is one of the many tools an agent can run.
It is not part of the product.

## System topology & lifecycle

At runtime the product is two tiers: a thin **Platform** (identity + sandbox-URL store) and a per-user
**Sandbox** (where the agent runs, reached by the browser directly). A sandbox can *also* stand up real
**infrastructure** on hosts you own — the third tier below — by running the bundled deployment engine, one
of its tools; that path is optional. The engine flow shown later is what runs *inside* one `intentic deploy apply`.

```mermaid
flowchart TB
    operator(["Operator (browser)"])

    subgraph cloud["Intentic Platform — identity + sandbox-URL store + billing"]
        web["Web UI · Vue (SPA)"]
        api["API · Hono / oRPC"]
        db[("Postgres<br/>account + billing + connection token<br/>+ sandbox URL + tunnel pool")]
        web --> api --> db
    end

    subgraph tenant["Tenant machine — your PC or a server"]
        subgraph sandbox["Sandbox — one per user · its own Cloudflare tunnel"]
            agent["Agents: Claude · Codex · Grok · Kimi Code · Gemini"]
            cli["intentic CLI"]
            repos["repos:<br/>intent · desired-state · app"]
        end
    end

    subgraph infra["Provisioned infrastructure — one or many hosts"]
        cp["Control plane<br/>Forgejo (git/registry/CI) · Komodo (deploy)"]
        appplane["Application plane<br/>apps · backings (db/cache/auth/storage)"]
    end

    operator -->|"sign in (Google) · load the SPA shell · store the derived sandbox URL (setup.bind)"| web
    operator ==>|"drive the daemon DIRECTLY (Google ID token, over the tunnel):<br/>chat · terminals · files · panels · automations · intentic"| sandbox
    cli ==>|"intentic deploy apply: SSH · Docker · Cloudflare API"| cp
    cli ==>|reconcile| appplane
```

- **Platform (identity + sandbox-URL store + billing)** — Vue SPA + Hono/oRPC API. Persists the
  operator's account and Stripe subscription (Better Auth; free = 1 sandbox, pro = unlimited +
  sharing), one secret-free per-user connection token, the sandbox's public `daemonUrl` (announced
  by the **daemon** on boot), member invites (a discovery mirror — the daemon is the enforcer), and
  a pool of pre-provisioned tunnels (`ReservedSandbox`) so setup pays no Cloudflare round-trips
  inline. It never probes the sandbox, owns no infrastructure, and sits **off the command path**.
- **Sandbox** — one per user, run **unprivileged by default**; container privileges come only from
  `# intentic:runtime` directives in the owner-approved overlay, applied by the allowlisted rebuild executors
  (the `docker` capability's `--privileged` wakes the image-baked, otherwise-dormant isolated Docker Engine so
  `pnpm db:up` / `docker compose` work in the workspace; the HOST's Docker socket is never mounted, so the
  agent's containers can only live inside the sandbox's own engine; its cloudflared runs as a separate sidecar
  container). Runs the coding agents (Claude via the agent
  SDK, Codex, Grok, Kimi Code, Gemini — spawned per turn, not resident) and the `intentic` CLI over the three repos
  (`intent` = `deploy.config.ts`, the IaC; `desired-state` = resolved artifact + status; `app` =
  the application code), and exposes its daemon over its **own Cloudflare tunnel**. SSH keys,
  Cloudflare and agent tokens ride straight into it and never reach the platform.
- **Trust root = browser Google Sign-In** — the browser proves its identity to the daemon with a
  Google ID token, verified against Google's JWKS, and the daemon binds its owner **on first use**:
  the first authenticated request must carry the `x-intentic-connect` connect token (and, when setup
  seeded an expected owner, match that account's email), then the owner email persists in
  `/work/.intentic/owner.json` ([auth.ts](_apps/sandbox/src/auth/auth.ts)). Because a Google ID token
  lives ~an hour and renewing it needs Google UI, it is only the **sign-in** credential: the browser
  exchanges it at `system.session` for a **daemon-minted session** (HMAC-signed with a secret that
  never leaves the sandbox, [session.ts](_apps/sandbox/src/auth/session.ts)) and presents that on
  every call, renewing it silently — Google reappears only for a first visit, an account switch, or a
  long-idle return. First-bind always takes a fresh Google proof, never a session. Additional
  collaborators are granted via `/work/.intentic/members.json`, and owner/membership are re-checked
  per request, so revoking a member kills their live sessions too. The platform never holds or forges
  either credential, so a platform breach can read the stored URL but **cannot drive any sandbox** —
  the hub's blast radius is bounded to identity + the sandbox URL.

The lifecycle, from first sign-in to a reconciled deployment the operator can watch:

```mermaid
sequenceDiagram
    actor U as Operator
    participant P as Platform
    participant S as Sandbox
    participant I as Infrastructure

    U->>P: Sign in (Google) + open setup
    P-->>U: curl one-liner + connection token
    U->>P: store derived sandbox URL (setup.bind: sandbox-<hash(token)>.<zone>)
    U->>S: curl … | sh   (docker run sandbox + its own Cloudflare tunnel)
    U->>S: probe /health directly until reachable (no platform involved)
    U->>S: drive directly — chat · Provision (Google ID token)
    S->>I: intentic deploy apply (SSH · Docker · Cloudflare)
    I-->>S: reconciled state
    S-->>U: stream events · topology · plan · deployments (direct)
```

### The sandbox daemon

The daemon ([_apps/sandbox](_apps/sandbox)) is the whole per-user product surface, not just a chat
endpoint. One Node process serves the oRPC contract on `:8787` and a preview proxy on `:5173`;
terminals, panel dev servers, and agent shell commands all run in a shared `tmux` server so they
survive reconnects. Its subsystems:

- **Agent backends** — Claude (agent SDK, spawned per turn), Codex, Grok/opencode, Kimi Code, and Gemini. Kimi
  and Google's models are re-served from subscription OAuth through the bundled translator on the Claude Code
  harness
  ([agent/](_apps/sandbox/src/agent/)), plus an anonymous website **webchat** widget over SSE. The four runtimes
  behind that seam (the Claude Code loop, Codex's exec surface, OpenCode, ACP) do not do the same things, so
  what each one *can* do is **declared**, not inferred: `capabilitiesOf(provider, harness)`
  ([sandbox-contract/agent-catalog.ts](_libs/sandbox-contract/src/agent-catalog.ts)) is one row per runtime —
  steering, permissions, questions, MCP, effort, isolation, commands, terminals, recovery — and both sides of
  the wire read it. The daemon gates its seams on it and strips the controls a runtime would silently drop
  ([agent/turn-plan.ts](_apps/sandbox/src/agent/turn-plan.ts)); the composer offers only the modes and knobs
  something applies, and names the rest as what this provider can't do. A capability is listed only if
  something reads it, and `agent-catalog.test.ts` walks PROVIDERS × HARNESSES so a new provider cannot arrive
  without a row
  ([webchat/](_apps/sandbox/src/webchat/)). A chat turn executes as a **detached run**
  ([agent/turn-runs.ts](_apps/sandbox/src/agent/turn-runs.ts)): `POST /agent` acks with a run id and the
  frames land in a seq-stamped log, which any number of clients render via `/agent/attach`
  (replay-from-cursor, then live) — so a turn survives reloads and dropped connections, and every window or
  device on the conversation streams it concurrently. Only `/agent/stop` cancels it. A turn also survives **the
  daemon**: every in-flight turn and automation fire is written to a **turn journal** on the history volume
  ([agent/turn-journal.ts](_apps/sandbox/src/agent/turn-journal.ts)) and cleared when it settles, so whatever
  is still there at boot is exactly what the process died under — and `resumeInterruptedTurns`
  ([agent/turn-resume.ts](_apps/sandbox/src/agent/turn-resume.ts)) re-runs it on the session holding its
  partial work. That matters because intentic's own flows cause the deaths: every update, environment approval
  and `dev-sandbox.sh` swap recreates the container, so approving the Dockerfile change an agent asked for used
  to cost the run that asked for it. On by default (`autoResumeOnRestart`), once per turn, and only for turns
  under six hours old — a turn that OOM-kills the daemon must not resurrect it on every boot. Not resuming is
  still recorded: the fleet card reads `interrupted` and an automation's row shows an `interrupted` run.
  The frame log itself stays in memory on purpose — the transcript's durable copy is the provider's session
  store, which every client replays from before it attaches.
- **Terminals** — interactive PTYs over WebSocket ([terminal/terminal.ts](_apps/sandbox/src/terminal/terminal.ts)).
- **Panels & previews** — per-repo dev servers behind `preview-<panel>-<id>.<zone>` hostnames
  ([panels/](_apps/sandbox/src/panels/)); plus generic **port forwarding** for anything run in a terminal
  (a procfs scan lists listening ports, an explicit forward maps one onto a fixed slot behind
  `port-<slot>-<id>.<zone>`, and Ctrl+clicking a `localhost:<port>` link in a terminal rides this
  automatically) ([ports/](_apps/sandbox/src/ports/)). Port targets get Host/Origin rewritten to
  `localhost:<port>` at the proxy, so stock dev-server host checks pass unconfigured. Desktop-sync users get the
  stronger guarantee automatically: the sync agent's port-mirror watcher binds those same ports on their own
  machine's localhost (see `@intentic/sync`), the only path where a frontend hard-coded to
  `localhost:<other-port>` works untouched.
- **Automations** — cron schedules, webhooks (`/automations/:id/fire`), and event listeners
  ([automations/](_apps/sandbox/src/automations/)). Any of them can be fired by hand with **Run now**
  (`POST /automations/:id/run`), down the same path the real trigger takes — a schedule stays a headless
  main-tree wake, and its guard still runs, because a test-fire that proved something else ran would prove
  nothing about the 3 a.m. one. Only the approval gate is skipped (the click is the approval), and a *disabled*
  automation fires too: trying a prompt before switching it on is the main reason to press it. Every run records
  the session it ran in, so the row's run history opens the transcript — the answer to "it failed overnight and
  I can't see why".
- **Doorbell** — a chat bubble a customer embeds on their own website, talking to a `webchat` listener
  automation ([webchat/](_apps/sandbox/src/webchat/), widget in
  [\_libs/webchat-widget](_libs/webchat-widget)). It is the inbound-HTTP mirror of the gateway-process pattern:
  no extension holds a connection, because the connection is a `<script>` tag on someone else's page. Four
  routes are exempt from the bearer middleware — `widget.js`, and per-automation `config` / `challenge` /
  `message` — and that set, written as **one predicate** in [app.ts](_apps/sandbox/src/app.ts), is the whole of
  what an anonymous internet user can reach on a daemon. The visitor holds no credential in any mode: even
  with Google sign-in on, the ID token is verified daemon-side against the *site's own* client id (intentic's
  cannot list every customer domain) and becomes a claim in the prompt, never a grant. Admission is the
  trigger's `allowedOrigins` plus a per-conversation rate limit and an optional bot check — Cloudflare
  Turnstile, or a built-in proof of work for sites with no Cloudflare account, spent once per visitor thread.
  Each thread maps to ONE sandbox conversation, resumed by session id
  ([webchat-sessions.ts](_apps/sandbox/src/webchat/webchat-sessions.ts)), so a five-message support chat is one
  fleet card the owner can watch live and take over — not five worktrees with amnesia. And because an
  automation turn runs `bypassPermissions` by default, a Doorbell's real boundary is `Automation.allowedTools`,
  carried into the SDK's own allowlist: prompt wording is advice, an empty toolbox is not. The config fetch
  doubles as the **install probe** ([webchat-installs.ts](_apps/sandbox/src/webchat/webchat-installs.ts)):
  every widget load records its origin and whether it was admitted, which is the only thing that can tell a
  working Doorbell nobody has written to from a snippet that was never pasted — and turns the commonest
  mistake of all (`example.com` listed, `www.example.com` not) into a named origin with an Allow button.
- **CI pipelines** — the workspace repos' GitHub Actions / GitLab pipelines, as both an automation source and a
  UI surface ([ci/](_apps/sandbox/src/ci/)). A repo participates when its remote's hostname matches a connected
  github/gitlab capability (`projects.ts` — self-hosted GitLab included, via the capability's instance url). A
  reconciler keeps a webhook on every mapped repo pointing at the public receiver `/ci/webhook/:host`,
  authenticated by a per-sandbox secret in `.intentic/ci.json` (GitHub signs the body, GitLab echoes the
  token); a refusal (token scope, role) degrades that repo to a warning carrying the manual hook recipe, the
  ssh-key-registration posture. Completed pipelines dispatch the core listener provider **`ci`** — the webchat
  precedent: no gateway extension, the daemon's own receiver is the source — with event types
  `pipeline_failed` / `pipeline_succeeded` / `pipeline_fixed` (a success ending a recorded failure streak on
  that repo+branch, remembered across restarts in `ci.json`), so a listener automation narrows by repo
  (`channelId`) and result. The same deliveries freshen the runs cache behind `GET /ci/runs`, which the
  **Pipelines** rail view ([\_extensions/pipelines](_extensions/pipelines)) polls — backfilled over the
  vendors' REST APIs when stale, so the view has history even where webhooks never registered. Row actions
  proxy rerun/cancel to the vendor, and **Fix with agent** (`POST /ci/fix`) opens an isolated conversation
  seeded with the failed jobs' log tails — a fleet card like any other agent.
- **Push notifications** — the daemon is the sender, because it is the only tier that knows what the agent is
  doing ([push/](_apps/sandbox/src/push/)). It owns a per-sandbox VAPID keypair and one subscription per
  subscribed browser, stored on the **history volume** rather than under `/work/.intentic`: the private key can
  forge notifications to the owner's devices, so it sits outside the agent's reach. Three moments notify — a
  turn settled, a turn parked on the user (plan/question/permission), and an automation held for approval —
  and every one is suppressed while anyone is present and non-idle on the sandbox (`idleEverywhere`, read off
  the same presence roster `/events` maintains), so a turn you watch finish tells you nothing. The service
  worker ([_apps/web/public/sw.js](_apps/web/public/sw.js)) is registered lazily and caches nothing; a
  subscription is per-browser, and lives on the web origin while the sender is the daemon on its tunnel —
  which works because a push endpoint is an absolute URL minted by the browser's own push service.
- **Capabilities** — everything a user adds to the sandbox (connectors, vpn, mcp, plugins, …),
  one unified model with a per-kind handler ([capabilities/](_apps/sandbox/src/capabilities/)) — see
  [Capabilities](#capabilities).
- **VPN** — putting the sandbox on a private network ([vpn/](_apps/sandbox/src/vpn/)) — see [VPN](#vpn).
- **Members** — shared access for invited collaborators, enforced by the daemon
  ([auth.ts](_apps/sandbox/src/auth/auth.ts)).
- **Workspace file service** — search, tree, watch, diff, and chunked multi-GB uploads
  ([workspace/](_apps/sandbox/src/workspace/)); desktop sync is Mutagen over tunnel SSH
  (`ssh-<id>.<zone>`, paired via `@intentic/sync`). Enrollment ([platform/sync.ts](_apps/sandbox/src/platform/sync.ts))
  carries a **mode**: `sync` (bidirectional file sync, SINGLE-HOLDER — two machines two-way-syncing `/work`
  would race) or `mirror` (port mirroring only, UNLIMITED — forwards are per-machine and independent, so every
  collaborator mirrors the ports to their own localhost at once). The **owner** may enroll either; a **member**
  is capped to `mirror` at pairing-mint. Each enrolled machine gets its own key in `authorized_keys` and its own
  `/ports`-scoped sync token, so machines revoke independently (self-revoke on uninstall; owner clears all).
- **History** — git snapshots every 60 s + per agent turn, on a `/history` volume mounted *outside*
  `/work` so an agent `rm -rf` can't reach it ([history/](_apps/sandbox/src/history/)). The same volume holds
  the managed ssh dir (`/history/ssh-hosts`, symlinked to `~/.ssh/intentic-hosts` at boot by
  [`linkSshHosts`](_apps/sandbox/src/capabilities/ssh-hosts.ts)): container recreates — every rebuild, update
  and `dev-sandbox.sh` swap — wipe `/root`, so a git-provider identity or an `ssh` capability's key kept there
  died on each one while the manifest still read "connected". What genuinely can't be persisted (`~/.gitconfig`,
  `~/.git-credentials`) is re-derived from the manifest at boot by
  [`restoreConnectorGitAccess`](_apps/sandbox/src/capabilities/cli/git-access.ts), the git counterpart to
  `reconnectVpns`. Every one of these HOME-level convergences — the ssh dir, the `~/.claude` session stores,
  `authorized_keys`, the git credentials — runs only for the daemon holding the container's HOME claim
  ([`claimContainerHome`](_apps/sandbox/src/platform/home-owner.ts)): HOME is shared by every process in the
  container, so a SECOND daemon started inside it (a dev run rooted under `/tmp`) otherwise repoints all of it
  at its own empty roots and takes the live sandbox's git access, transcripts and desktop enrollment down
  without an error anywhere.
- **Environment overlays** — agent-proposed Dockerfile layers, applied only after owner approval
  ([environment/](_apps/sandbox/src/environment/)).
- **Discord** — chat/stream/voice integration, now an image-baked extension: a gateway `process` +
  `listener` in [\_extensions/discord](_extensions/discord).

**One image, two ways to start.** The sandbox `connect.sh` runs on your PC and the one the
`i.want.workspace` provider deploys onto a remote host (over SSH) are the *same image*. The desktop app
([_apps/desktop](_apps/desktop)) is not a third way: it *spawns that same `connect.sh`*, which is what makes
its onboarding identical to the pasted one rather than a second implementation to keep in step. Either way the
tunnel is named `sandbox-<id>` where `<id> = sha256(connectToken).slice(0, 12)`
([tunnel-ids.ts](_libs/sandbox-contract/src/tunnel-ids.ts)), and it is provisioned one of two ways:

- **Own Cloudflare** — `connect.sh` runs `intentic tunnel sandbox` against the *user's* zone:
  `sandbox-<id>.<zone>` for the daemon, `ssh-<id>.<zone>` for desktop sync, plus the `*.<zone>`
  wildcard for panel previews. The user's Cloudflare account absorbs all of it.
- **Intentic-provided** — for users with no Cloudflare, the platform provisions the tunnel on
  intentic's own account under a shared zone (`sandbox-<id>.intentic.dev`) and hands the sandbox only
  the narrow per-tunnel connector token. A shared zone can't give each user a wildcard, so the daemon
  asks the platform to mint preview routes (`preview-<panel>` / `port-<slot>` labels, batched per call) —
  panel labels lazily as repos appear, and the whole fixed port-slot pool (`PORT_SLOTS`) eagerly: slot
  routes are created at tunnel provisioning and re-ensured by the boot sweep, so a port forward never
  waits on fresh DNS, and churning dev-server ports cost at most the pool's size in routes per sandbox, ever.

On a server the workspace is just another service on that host's shared tunnel, exposing only the
preview wildcard (the daemon stays host-internal — the server workspace is preview-only; `connect.sh`
is the browser-direct path). The infrastructure it *provisions*, either way, builds Cloudflare tunnels
on its target hosts (see below) — which is how the system fans out to "workers on many machines."

### Cloudflare is the reachability fabric (required)

Cloudflare is not a user-facing convenience — it is the system's **reachability fabric**, and it is
**required**. The operator never needs to open `git.<zone>` / `deploy.<zone>`; the **browser reads the
control plane through the sandbox daemon directly** (over the sandbox's tunnel). How each piece is reached
is asymmetric:

| Reached over | Who / what |
| --- | --- |
| **SSH** (loopback port-forward to `:3000` / `:9120`) | The **engine's entire control path**: every Forgejo API call (repo/ci/users/orgs/teams/hooks) and every Komodo API call (deployments/users/alerters/servers), plus `intentic deploy adopt`'s REST calls and git pushes. The engine never dials a public route it may itself be reconciling — apply and adopt work with the tunnel down, or before DNS exists at all. |
| **Cloudflare tunnel** (public `*.<zone>`) | Everything genuinely cross-host or external: browsers/operators, every worker host's Komodo Periphery dialing Core (`deploy.<zone>`), registry pulls (`git.<zone>`), and hosted-forge CI runners' notify step. |

Why a tunnel, rather than "just use SSH and make Cloudflare optional":

- **Outbound-only, NAT-traversing.** `cloudflared` dials out, so it works behind NAT/firewalls with no
  inbound ports — the same bet the sandbox already makes to expose its daemon.
- **Cross-host coordination needs stable, routable names.** Worker→Core registration and image pulls are
  host-to-host; SSH from the sandbox only reaches *sandbox→service*, so an SSH-only design would still have
  to add an overlay network to serve them.
- **The registry forces a global name anyway.** Image refs (`git.<zone>/owner/app:tag`) must resolve
  identically from every host that pulls — that alone mandates a stable domain.
- **One uniform primitive** (`<name>.<zone>`, TLS'd, reachable from anywhere) keeps the model trivially
  reason-about-able; a second internal/SSH mode would mean two reachability models and a combinatorial matrix.

This is enforced in code, not just convention: the SDK types require `expose: Cloudflare`, and both
`resolveNeeds` ([needs.ts](_libs/need-resolver/src/needs.ts)) and `emit`
([emit.ts](_libs/state-resolver/src/emit/emit.ts)) throw when it is missing — there is no alternative ingress.
The Cloudflare API token is supplied at **connect** time (it rides `connect.sh` into the sandbox) and consumed
at **provision** time by `intentic deploy apply`. It never reaches the platform except for one request-scoped call at
setup — the platform lists the token's zones so the user can pick which one the sandbox tunnel uses (the browser
can't call Cloudflare directly), then drops the token: never persisted, never logged.

> The sections from here through **Packages** document the **bundled deployment engine** — a standalone
> infra tool that ships in this monorepo and is one of the many tools an agent can run. It is **not part of
> the intentic product** (the product is the app plane, covered below).

## The intent-driven flow

```
Intent ──► NeedResolver ──► Needs ──► StateResolver ──► desired state ──► Execute ──► (reads true)
```

1. **Intent** — a declaration authored with the SDK: `i.have.*` (the inventory you bring — read, never
   created or destroyed: `host`, `cloudflare`, `github`, `gitlab`, `backup`, `discord`, `stripe`) and
   `i.want.*` (what intentic owns end-to-end — created, reconciled, pruned, destroyed: `app`, `service`,
   `workspace`, `database`, `cache`, `auth`, `objectStorage`, `user`, `team`), each
   app wired to its host/Cloudflare via `on` / `expose`. Captured as a serializable `IntentSet`.
   ([_libs/sdk/src/stack.ts](_libs/sdk/src/stack.ts))
2. **Need resolver** — derives the abstract capabilities the intent requires: `source-control`,
   `docker-registry`, `infra-control` (control plane), `deployment-target`, `domain` (application plane).
   (`resolveNeeds` in [_libs/need-resolver/src/needs.ts](_libs/need-resolver/src/needs.ts))
3. **State resolver** — assigns each need its catalog option and compiles the emitted nodes into one
   **desired state** (a `DesiredStateGraph`). The catalog maps capabilities to the concrete things that
   satisfy them; one option may cover several (Forgejo provides both source-control and docker-registry).
   `catalogFor(intent)` selects the source control: `i.have.github` ⇒ GitHub (GHCR + Actions),
   `i.have.gitlab` ⇒ GitLab (its registry + CI), otherwise the self-hosted Forgejo default. **Komodo is
   unconditional** — on every stack CI only builds and pushes the image and Komodo rolls it out, so no
   host SSH credential ever reaches a hosted forge and the host stays outbound-only. The intent fully
   determines the result — within the selected catalog there is exactly one option per capability, so
   resolution stays deterministic. (`resolveState` in
   [_libs/state-resolver/src/state.ts](_libs/state-resolver/src/state.ts), over `catalogFor` in
   [catalog.ts](_libs/state-resolver/src/lib/catalog.ts) and the nodes emitted by
   [emit.ts](_libs/state-resolver/src/emit/emit.ts))
4. **Execute** — apply the desired state and re-read it, looping until a plan reads all-noop ("state reads
   true"). (`reconcile` in [_libs/engine/src/reconcile/reconcile-loop.ts](_libs/engine/src/reconcile/reconcile-loop.ts), over
   `apply`/`plan` and the Provider SPI)
5. **Prune** — after convergence, deletion converges too, from two sources: the baseline diff (resources in
   the last-applied artifact the new one no longer declares) and the **collection scan** — each provider's
   `list` enumerates its live stamped resources (`intentic.id` / `intentic.type` labels, stamped DNS-record
   comments) and everything absent from the graph is an orphan, pruned without needing any baseline.
   Deletions require `apply --yes` (pending ones are previewed otherwise), nodes with a `protect: true`
   input (stateful backings by default) are never deleted, and `intentic deploy destroy --yes` is the same prune
   against the empty graph. Drift detection is also stamp-based: every resource carries an `intentic.hash`
   of its serialized inputs, and a mismatch reads as an update regardless of the provider's own diff.
   (`prune`/`pruneOrphans` in [prune.ts](_libs/engine/src/reconcile/prune.ts), `collectOrphans` in
   [orphans.ts](_libs/engine/src/reconcile/orphans.ts), stamps in [stamp.ts](_libs/graph/src/stamp.ts))

A `DesiredStateGraph` is the central data structure: a serializable, dependency-ordered set of resource
nodes with refs, secrets, and readiness gates. ([_libs/graph/src/types.ts](_libs/graph/src/types.ts))

## Output contract (driving the CLI as a service)

The engine separates two seams on `EngineConfig`: `log` carries providers' free-form strings, and
`onEvent` emits structured `EngineEvent`s for lifecycle progress — `node` (apply/plan, start/done with
the action), `readiness`, `iteration`, `prune`, and `orphan`
([types.ts](_libs/engine/src/types.ts)). The CLI selects a renderer from `INTENTIC_OUTPUT`
(`text` | `json` | `ndjson`) in [output.ts](_apps/cli/src/lib/output.ts): `text` is the human default
(unchanged), `json` serializes the command's returned outcome once, and `ndjson` streams each event as
a line then a terminal `result`. The final result is built from the engine's return values
(`PlanOutcome`/`ConvergeResult`/`PruneOutcome` and `collectAccess`), never from events — so a control
plane gets both live progress and a parseable summary, and embedders consume `EngineEvent` directly.

## Control plane vs application plane

Every need carries a `plane` — its role, independent of where it runs ([needs.ts](_libs/need-resolver/src/needs.ts)):

- **Control plane** — the deploy machinery: `source-control` + `docker-registry` (Forgejo by default,
  GitHub/GitLab when declared) and `infra-control` (Komodo, on every stack) — git/CI plus the deploy
  orchestrator. The local `intent` repo
  (`deploy.config.ts`) and `desired-state` repo (the artifact + execution status) drive it: `intentic
  resolve` runs the flow above and writes the artifact, `intentic deploy apply` executes it. A remote, PR-managed
  control plane (a standalone Forgejo watching the intent repo) is a planned later evolution of this same
  flow. ([_apps/cli/src/resolve/resolve.ts](_apps/cli/src/resolve/resolve.ts), [artifact.ts](_apps/cli/src/lib/artifact.ts),
  [app.ts](_apps/cli/src/app.ts))
- **Application plane** — what actually serves an app: its `deployment-target` (the app's runtime on the
  host) and its `domain` (the Cloudflare tunnel + DNS routes). Both are *derived from* `i.want.app` and
  emitted alongside the control-plane stack. ([_libs/state-resolver/src/resolvers/platform.ts](_libs/state-resolver/src/resolvers/platform.ts),
  [_libs/providers/](_libs/providers/src/))

The whole per-host support stack is self-contained: its control-plane Forgejo is just another reconciled
node, so `apply` needs no pre-existing control plane. A future remote control plane would reuse the same
`forgejo` provider — a different node instance, not a different implementation.

## Packages

Dependency direction (one-way):

```
graph ──► resources ──► engine ──► providers
   │           └──────► state-resolver ──► sdk
   ├──► need-resolver ──► state-resolver
   └──► (cli ◄── need-resolver, state-resolver, engine, providers)
```

| Package | Tier | Role |
| --- | --- | --- |
| [`@intentic/graph`](_libs/graph) | lib | Product-agnostic IR: refs, secrets, readiness, `DesiredStateGraph`, and the compiler. |
| [`@intentic/resources`](_libs/resources) | lib | The closed resource vocabulary shared by the state resolver, engine, and providers: `ResourceType`, `ResolvedNode`, and `OUTPUTS`. |
| [`@intentic/need-resolver`](_libs/need-resolver) | lib | The need resolver: intent → needs. Owns the authored intent/input shapes, `resolveNeeds`, and `Capability`/`Need`/`Plane`. |
| [`@intentic/state-resolver`](_libs/state-resolver) | lib | The state resolver: needs → desired state, over the option catalog. `resolveState`, the catalog, `emit`, and the platform/app/route/id derivation. |
| [`@intentic/sdk`](_libs/sdk) | lib | Authoring surface (`i.have.host` / `i.have.cloudflare` + `i.want.app`); `defineIntent` (→ `IntentSet`) and `defineStack` (one graph). |
| [`@intentic/engine`](_libs/engine) | lib | Stateless reconcile engine: `plan`/`apply`, the Provider SPI, and the `reconcile` loop. |
| [`@intentic/providers`](_libs/providers) | lib | Real Provider SPI impls: control plane (Forgejo, GitHub, GitLab, Komodo, repo/CI), network (Cloudflare tunnels + routes), hosts (SSH/Docker, deployment, workspace), backings (Postgres, Valkey, Garage, Authentik), services (SigNoz, Outline, Paperless, OpenProject, Invoice Ninja, Infisical), integrations (Discord, Stripe), ops (restic backup). |
| [`@intentic/sandbox-contract`](_libs/sandbox-contract) | lib | oRPC wire contract for the sandbox daemon — shared by the daemon and its browser client (the platform consumes it from npm). |
| [`@intentic/scaffold`](_libs/scaffold) | lib | Shared workspace scaffold: the intent-repo skeleton + deploy.config managed-region render/parse, used by the CLI's `init` and the sandbox daemon. |
| [`@intentic/cli`](_apps/cli) | **app** | The `bin: intentic` toolbox — three command groups: `tunnel` (`sandbox`/`host` — the sandbox's own Cloudflare tunnels, used by connect.sh), `deploy` (`init`/`resolve`/`plan`/`apply`/`destroy`/`adopt`/`restore`/`secrets`/`deployments`/`logs` — the bundled deployment engine), and `scaffold` (`monorepo`/`add-app`) ([app.ts](_apps/cli/src/app.ts)). |
| [`@intentic/sandbox`](_apps/sandbox) | **app** (image) | The per-project multi-agent dev workspace daemon (see [The sandbox daemon](#the-sandbox-daemon)), reached by the browser directly over its own Cloudflare tunnel. |
| [`@intentic/sync`](_apps/sync) | **app** | Local background agent keeping a directory bidirectionally in sync with a remote sandbox — one HTTP enrollment call, then Mutagen over tunnel SSH. The daemon grants a **mode** at enrollment (file `sync`, or `mirror`-only for collaborators — see the workspace file service above), and the agent adapts: `sync` runs file sync + mirroring, `mirror` skips file sync and only forwards ports. `setup` auto-starts a **port-mirror watcher** (a detached, pidfile-guarded loop) that binds the sandbox's workspace ports onto the desktop's SAME localhost ports via Mutagen TCP forwards, polling the daemon's `/ports` (read with the enrollment-minted, `/ports`-scoped sync token) so newly-started dev servers appear automatically, and **registers it for login autostart** (launchd / the per-user Windows Run key, as Mutagen's own daemon does / XDG autostart) so it resumes after a reboot. Each `setup` first **retires the previous pairing** — it stops the resident watcher (which would otherwise keep serving the new config on the agent binary that run just replaced) and terminates every session under this agent's name prefix: forwards, because Mutagen holds a dead sandbox's localhost ports until told otherwise and the next pairing would read them as "busy", and the previous file-sync session, because Mutagen re-dials a disconnected one every 15s for as long as the daemon lives. On Windows the watcher runs with a **windowless console** rather than detached — a detached process has no console at all, and Windows gives each console child of one (the bridge's `git` → `ssh` → `cloudflared`, every tick) a new console *window*. Revocation is symmetric: after consecutive definitive token rejections (the owner clicked Disable, or the sandbox lost the enrollment) the watcher **tears itself down** — forwards, pidfile, and the autostart entry — instead of polling a dead enrollment forever. Remote dev servers then behave exactly like local ones — localhost URLs, cookies, and CORS included — with no command to run, ever, and **every collaborator can mirror the same sandbox at once**. The state home, autostart mechanisms, self-relaunch and detached-loop spawn are [`@intentic/local-agent`](_libs/local-agent)'s. |
| [`@intentic/desktop`](_libs/desktop) | lib | Drive a desktop from Node — capture the screen, move the pointer, click, type, press chords, scroll, drag — on Windows and Linux with **no native modules** (the consumer ships as one compiled binary, so node-gyp is not an option). Windows goes through PowerShell into `user32.dll`: `SetCursorPos`/`mouse_event` for the pointer, `keybd_event` for chords, and `SendKeys` for text ONLY — it is the one that handles arbitrary unicode and the one that cannot press the Windows key, so the split is not arbitrary. Linux is two backends behind one interface: X11 synthesises input freely via `xdotool`, Wayland refuses to, so the pointer needs `ydotool` (`/dev/uinput`) and text/keys prefer `wtype` (no privileges) — a missing tool raises an error carrying its exact install line. Knows NOTHING about agents, scopes or sandboxes: it takes coordinates and makes a computer do something, and whether that is allowed is asked before these methods are called (`@intentic/host`'s tools/computer.ts). That separation is what makes the policy testable at all, since a real click can only be verified by a human watching a screen. It also operates APPLICATIONS rather than only pixels — list the open windows (app, title, bounds, focus), focus one, launch an app or URL, read and write the clipboard — which is what makes GUI work reliable rather than blind: typing lands in the FOCUSED window, so an agent that cannot enumerate or focus is guessing every time. Windows enumerates through `Get-Process` plus a P/Invoke for the rectangle and the foreground handle; X11 through `wmctrl`/`xdotool`; Wayland only on wlroots compositors via `swaymsg -t get_tree`, because a compositor refusing to let one client enumerate another's windows is the same protection that stops it synthesising input — everything else gets a sentence saying so instead of an empty list that reads as "nothing is open". Two details it owns: coordinates are SCREENSHOT pixels and `frame()` reports the virtual desktop's origin (negative on a monitor left of the primary), so multi-monitor stops being a source of silent misclicks; and one key vocabulary (X11 keysyms plus the aliases people type — `enter`, `esc`, `win`, `cmd`) is rendered three ways, so no caller is platform-aware. |
| [`@intentic/browser`](_libs/browser) | lib | Drive a Chromium browser over CDP — open pages, read them as STRUCTURED TEXT, click and type by element reference. No dependencies: the protocol is JSON and `fetch`/`WebSocket` are globals, which matters because this ships inside a compiled binary where a native-addon library proved unloadable (see @intentic/desktop). The point is references instead of coordinates: a snapshot returns every visible element with its role, accessible name and current value, and actions name an element rather than a position — so the same instruction survives scrolling, resizing, re-rendering and a different screen, none of which a pixel click survives. Refs are short-lived by design (they index an array parked on the page, replaced by the next snapshot), so a ref taken before a navigation fails loudly instead of clicking whatever now occupies that slot. It drives a SEPARATE browser instance with its own profile under `~/.intentic/host/browser`, never the user's own: a browser only speaks CDP if it was started with a debugging port, and restarting theirs to add one would close every tab they had open — so their session is never automated, and the agent's logins are ones the user performed deliberately in a window they could watch. |
| [`@intentic/local-agent`](_libs/local-agent) | lib | The plumbing every intentic CLI that lives on a USER'S OWN COMPUTER needs, and none of what any of them does: the `~/.intentic/<name>` state home and the 0700/0600 floor everything written into it gets; how a CLI re-invokes itself; login autostart per OS; and the detached background loop found again by pidfile. Its three consumers — `@intentic/host`, `@intentic/sync`, `@intentic/acp-bridge` — were written months apart, and each copy of this was made from the last one, which is a shape with a known ending: the second copy is a snapshot of the first on the day it was taken, and every fix after that lands in one of them. It already had. Sync wrote its token file **world-readable** because its config module was copied from host's before that floor existed; host has no macOS autostart because it was copied from a sync that did not have one yet, and wrote an XDG entry macOS never reads; and the Windows console rule, the compiled-binary `argv` rule and "report what the tool actually said" were each written out at length in two files, in prose, cross-referencing the other agent by name — including in this table. The autostart mechanisms are all the user's OWN (per-user Windows Run key, launchd LaunchAgent, XDG entry): no elevation, no password prompt, no machine-wide change. Windows gets the DETACHED command and the supervising mechanisms get the FOREGROUND one, because Explorer starts a Run entry in the interactive session where the loop would park a console window on the desktop from login until shutdown. macOS is opt-in per agent, so one that has not been exercised there says so instead of writing a file nothing reads. Knows nothing about sandboxes, tunnels, enrollment or MCP. |
| [`@intentic/host`](_apps/host) | **app** | Local agent that lets the sandbox's agent WORK ON the user's own computer — the machine half of the `host` capability (the sandbox half is [hosts/](_apps/sandbox/src/hosts)). The machine cannot be dialled (NAT, proxy, closed lid), so it dials US: one outbound WebSocket, authenticated by an enrollment token carried in its first FRAME (never a URL, which would put a durable key to somebody's laptop into edge logs). After that frame the socket is **oRPC**: the machine SERVES `hostContract` (`describe`/`setScopes`/`ping`/`mcp`) and the daemon holds the client — the adapter attaches to either peer, so who dialled and who serves are independent, and correlation, argument validation and error shape belong to the link rather than to hand-rolled frames. Exactly one procedure is deliberately untyped: `mcp`, which carries MCP JSON-RPC **verbatim** in both directions, because a contract that described each tool would force the daemon to know every schema and end a machine's ability to learn a tool without a daemon release. The tool surface (`run_command`, `read_file`, `write_file`, `list_dir`, `trash_file`, `screenshot`, `describe`) therefore lives in THIS binary, and there is deliberately no delete tool (trash is recoverable). **Scopes are enforced here**, never in the sandbox: the daemon pushes the owner's switches down on every connect and on every edit, and a call outside them comes back as a readable refusal naming the switch — so a compromised sandbox, or an agent talked into something by what it read, still cannot exceed the grant. Every call is appended to an audit log on the machine, which survives `uninstall` because it is the user's record. Installation and lifecycle — the `~/.intentic/host` state home and its 0600 credential floor, self-relaunch, login autostart, the detached loop and its windowless-console Windows spawn — come from [`@intentic/local-agent`](_libs/local-agent), which is where those lessons now live as code rather than as prose cross-referencing `@intentic/sync`. |

The libs + the CLI publish to npm; **`sandbox` ships as a Docker image** to the GitLab Container
Registry (`registry.gitlab.com/radarsu/intentic/sandbox`) — published by
[_tools/scripts/publish-images.sh](_tools/scripts/publish-images.sh) (which also publishes the `dind-host` test-host
image): `latest` + commit SHA on push to main, `<version>` + the moving `stable` tag on release.
[`images.ts`](_libs/state-resolver/src/lib/images.ts) records it at `:stable` — the deliberate unpinned
exception among the otherwise digest-pinned deployed images (never `:latest`), so released sandboxes
track releases without a graph change. The registry package is public so tenant hosts pull it
unauthenticated; both `connect.sh` (your PC) and the `workspace` provider (a server) run this image
directly.

## The app plane — the product

The **app plane** is the intentic product: the co-piloted agent workspace a user actually looks at, a
VSCode-shaped file editor. (The intent→reconcile **deployment engine** documented in the preceding sections
is a *bundled tool* the sandbox can run — one tool among many — not part of this product.) The app plane's
dependency edges into `@intentic/*` all go through `sandbox-contract` (and one type-only reach into
`@intentic/resources` from `api-contract`); the engine core never depends back on the app.

| Package | Role |
| --- | --- |
| [`@intentic-app/web`](_apps/web) | The Vue 3 SPA shell — the editor UI (rail · workspace tree + file viewers + Monaco · chat). Signs in against the platform, then drives the sandbox daemon **directly** over its tunnel. The **extension host** lives here. |
| [`@intentic-app/api`](_apps/api) | The thin platform: Better Auth sign-in + the `setup.*` handshake + Stripe. Off the command path (see topology above). |
| [`@intentic/desktop-app`](_apps/desktop) | The Windows/Linux desktop app (Tauri 2). Its workspace window IS the hosted SPA, with no IPC — the only channel in is an intercepted `intentic://` link. The native half runs the SHIPPED scripts (`connect.sh`, `recreate.sh`, `cleanup.sh` and their PowerShell twins) rather than reimplementing them, so the desktop and terminal paths are the same file; and because the daemon holds no host Docker socket, this app is the only thing that can turn "paste this command on the machine that runs your sandbox" into a button. Sign-in happens in the user's real browser and returns over the deep link (Google refuses embedded webviews). See [_apps/desktop/README.md](_apps/desktop/README.md). |
| [`@intentic/sandbox`](_apps/sandbox) | The per-user daemon (documented under [The sandbox daemon](#the-sandbox-daemon)) — also the app plane's whole backend: workspace files, chat, terminals, panels, search, settings, and the daemon-side half of the extension system. |
| [`@intentic/sandbox-contract`](_libs/sandbox-contract) | **The keystone wire contract** — the oRPC route + schema surface shared by the daemon, the web client, and every UI extension (~15 dependents). It is deliberately *the* first-party data contract: because everything that consumes it is in-repo and compiled together, a wire change is caught by the compiler and fixed atomically, so there is no separate "stable API" shim to maintain. |
| [`@intentic-app/api-contract`](_libs/api-contract) | The platform (web↔api) oRPC contract. |
| [`@intentic/ui`](_libs/ui) | The app design system (PrimeVue + Tailwind primitives). |
| [`@intentic-app/capability-catalog`](_libs/capability-catalog) | Capability/connector catalog data rendered by the web. |

### Extension system

The app is a **lean core + an extension system**, the same bet VSCode makes. An extension is a package
with an `intentic-extension.json` manifest at its root ([manifest.ts](_libs/extension-api/src/manifest.ts));
identity is derived, never declared (`extensionIdOf = ${publisher}.${name}`). The manifest is the
**approval + gating surface**: the install dialog shows exactly the declared contribution points, and the
host refuses any runtime registration the approved manifest never declared. Contribution points cover both
UI (`views`, `viewers`, `commands`, `settings`) and daemon/agent surface (`processes`, `agent`,
`environment`, `connectors`, `listener`, `bin`). A UI extension ships a prebuilt ESM `entry` bundle and an
`activate(api, context)` function; there is no ambient global — the host `IntenticApi` arrives as the
`activate` argument, and everything registered is a `Disposable` pushed onto `context.subscriptions` so
deactivation unwinds cleanly ([api.ts](_libs/extension-api/src/api.ts)).

Two boundaries are load-bearing and easy to confuse — the distinction is the most important architectural
line in the app:

- **`_apps/web/src/extension-host/`** — the real host. It loads git-installed third-party bundles
  (`GET /extensions` → engines check → authenticated bundle fetch → `import()` → `activate`) and the
  compiled-in first-party extensions ([extension-host/builtins.ts](_apps/web/src/extension-host/builtins.ts)),
  **both through the same manifest-gated `createExtensionApi`** ([apiImpl.ts](_apps/web/src/extension-host/apiImpl.ts)).
  A builtin extension can touch only the public `IntenticApi`, never app internals — that is the dogfooding
  boundary that keeps the first-party extensions honest.
- **`_apps/web/src/core-views/coreViews.ts`** — three *core* view contributions (`infrastructure`,
  `live-status`, `directory-ui`) that are extension-*shaped* but stay in the app because each is genuinely
  coupled to platform/onboarding or the file-open iframe bridge. They register through the same runtime
  registry but consume privileged internals **by design**, and the file documents exactly why each one
  can't be a clean extension.

The **data plane** an extension talks to is `sandbox-contract` over an authenticated transport
(`api.sandbox.request/json` — auth injected host-side, tokens never seen by the bundle). An extension's
reach into daemon routes is **declared in its manifest and gated by the host**, so coupling is explicit and
reviewable rather than ambient. The narrow `facts.ts` surface
([facts.ts](_libs/extension-api/src/facts.ts)) is only the stable **detection** vocabulary a view's
`detect()` reads to decide when to activate — not the data plane. The SDK is published as two npm packages:
[`@intentic/extension-api`](_libs/extension-api) (types + manifest schema) and
[`@intentic/extension-ui`](_libs/extension-ui) (a host-provided slice of the app design system, resolved at
runtime via an import map so every extension shares the shell's one Vue/PrimeVue instance).

What an extension **bundles** is exactly its declared contributions: a prebuilt ESM `entry` (UI) with
`views` / `viewers` / `commands` / `settings`; `capabilities` — a capability CARD as pure data (catalog card +
config fields, plus per-kind payload: a cli connector's env templates + SKILL.md + optional client-image
fragment, a browser platform's login URL + SKILL.md, a host OS pack's SKILL.md), rendered by the web as a
*derived* capability card and resolved by the daemon's generic handler for that kind — never a handler of its
own (see [Capabilities](#capabilities)); `processes` (daemon-run,
tmux-managed background processes); `agent` (a directory that is a Claude Code plugin —
skills/agents/hooks/.mcp.json, handed to the Agent SDK's plugin loader each turn); `environment` (a
RUN/ENV-only Dockerfile fragment baked into the sandbox image overlay); `bin` (executables prepended to the
agent's PATH); `listener` (a realtime event provider its gateway process implements); and
`permissions.sandbox`, the daemon-route allowlist gating its data plane.

First-party extensions live in `_extensions/` and reach the product by one of **three load paths** — but by
**one list**: every extension, whatever its path, is enumerated by `installedExtensions()`
([installed-extensions.ts](_apps/sandbox/src/extensions/installed-extensions.ts)) and served by
`GET /extensions`, which is what the Sandbox hub's Extensions tab renders and what the on/off switch acts on.

- **Compiled into the web bundle** — the UI extensions (`acceptance`, `activity`, `automations`, `logs`,
  `memory`, `pipelines`, `preview`, `repo-apps`, `viewers`), statically imported and keyed by manifest id
  ([extension-host/builtins.ts](_apps/web/src/extension-host/builtins.ts)). They ship no `entry` over the
  wire — the bundle IS the SPA — but their manifest is baked into the image beside the daemon-side ones, so
  the daemon lists them and the loader's only question per extension is where its code comes from. The two
  ways image and bundle can disagree are surfaced as states, not silence: `missing` (manifest, no module) and
  `unlisted` (module, no manifest — activated anyway, so the rail survives an older image).
- **Baked into the sandbox image** — the daemon-side ones ship their whole checkout at `/opt/extensions`
  (Dockerfile bake, `EXTENSIONS_DIR`) and are served as `builtin: true` — present in every sandbox, not
  removable, no capability entry. Four are pure data and exist to hold the `/capabilities` grid's derived
  cards (`connectors`, `social`, `computers`, `acp-agents`); three ship a gateway process as well (`discord`,
  `slack`, `imap`). This is how those cards exist out of the box, and why switching one of those packs off
  removes exactly its cards.
- **Git-installed** — the `extension` capability: an owner-only, full-sha-pinned clone into
  `.intentic/extensions/<id>`, validated before swap. Third-party extensions arrive this way; of the
  first-party ones only `rtk` does, because its environment fragment composes per capability entry.

Any of them can be **switched off** — `POST /extensions/{id}/enabled`, recorded in
`.intentic/extension-enablement.json` by `publisher.name`. A disabled extension stays listed (that is what
keeps its switch reachable) and drops out of `enabledExtensions()`, which every consumer that wires something
up iterates, so it contributes no agent plugin dir, PATH entry, listener provider, connector card, env var or
autoStart process; the web loader retires its activation in place. `agent` and `bin` are composed per turn and
`environment` only at image rebuild, so those three apply later — the tab states which per extension.

Note the current split is a **UI veneer**: an extension is mostly where its
Vue lives, while its backend (activity, automations, logs, panels…) still sits in the daemon core — moving
those behind a daemon-side extension runtime is a deliberately deferred, marketplace-phase step, not a
gap to close now.

### Capabilities

Everything a user adds to a sandbox is a **capability**: one `{ id, kind, config }` entry in a single
discriminated union (`CapabilitySchema` in [schemas.ts](_libs/sandbox-contract/src/schemas.ts)) over the
kinds — `devops`, `monorepo`, `mcp`, `service`, `integration`, `cli`, `plugin`, `extension`, `ssh`, `vpn`,
`docker`, `browser`, `host`, `agent`, `endpoint`. There is deliberately **no top-level taxonomy** of "skills vs connectors vs
environments vs secrets": those are overlapping *ingredients*, not disjoint categories (a connector is a
skill + a secret + env injection + maybe an image fragment; an extension is a repo + skills + processes +
views + a fragment), so the model unifies the noun and differentiates behaviour per kind — the same bet
VSCode makes with "everything is an extension", disclosed per item instead of classified up front. The
machinery is uniform:

- **One manifest** — `/work/.intentic/capabilities.json` is the source of truth for what's active
  ([capabilities-store.ts](_apps/sandbox/src/capabilities/capabilities-store.ts)); secrets live in it and
  are denylisted from agent reads, and list responses echo them only as `hasToken`/`hasSecret` booleans.
- **One lifecycle** — `add` (streams its apply progress live), `remove`, `status`, `setSecret`
  ([capabilities.contract.ts](_libs/sandbox-contract/src/contracts/capabilities.contract.ts), orchestrated
  by [capabilities.routes.ts](_apps/sandbox/src/capabilities/capabilities.routes.ts): precondition check →
  streamed `apply` → manifest upsert → environment recompose).
- **One total registry** — `Record<CapabilityKind, CapabilityHandler>` where a handler is
  `{ requires?, fragment?, apply, status, remove? }`
  ([registry.ts](_apps/sandbox/src/capabilities/registry.ts),
  [capability.ts](_apps/sandbox/src/capabilities/capability.ts)) — a new kind is a compile error
  until it is handled everywhere, including the effects deriver and the secret/echo switches.

**The catalog is extensible; the handlers are core.** This is the line the whole `/capabilities` grid is
drawn on, and it is the honest version of the VSCode bet for this system. VSCode's core owns the privileged
primitives and extensions *compose* them; here the handlers **are** the privileged primitives — `docker`
bakes `--privileged`, `vpn` bakes `NET_ADMIN`, `host` pushes the enforcement boundary onto somebody's
personal laptop, `extension` installs extensions. A manifest that could contribute one of those is a
manifest that grants itself privilege, so **no handler is contributable, ever**. What an extension supplies
instead is a **card**: the data that varies between two cards served by the *same* handler.

Four kinds are card-driven, and the restriction is the `CapabilityContributionSchema` discriminated union
([manifest.ts](_libs/extension-api/src/manifest.ts)) rather than prose — a manifest naming any other kind
fails to parse:

| Contributable kind | What the card carries | Who ships the first-party ones |
| --- | --- | --- |
| `cli` | fields + env templates + a SKILL.md + an optional client-image fragment | `connectors`, `discord`, `slack`, `imap` |
| `browser` | a login URL + a SKILL.md (one Chromium serves every platform — that stays core) | `social` |
| `host` | an OS skill pack (enrollment, socket and scope enforcement stay core) | `computers` |
| `agent` | field defaults only — a preset over one config shape | `acp-agents` |

Everything else keeps a static card in `CAPABILITY_CATALOG`
([capability-catalog](_libs/capability-catalog/src/index.ts)), and every one of those is one-to-one with a
handler it cannot be separated from. `integration` is the instructive case: its card *looks* like pure data,
but it becomes an `i.have.<provider>` entry that only the desired-state resolver's closed
`InventoryProviderSchema` vocabulary understands — so the vocabulary belongs to the deploy engine, not to a
manifest, and Stripe stays static.

The web's grid ([Capabilities.vue](_apps/web/src/pages/Capabilities.vue)) merges the static cards with cards
**derived** from the **enabled** extensions' `contributes.capabilities` (`contributionCard()`). Enabled, not
merely installed: a switched-off extension stays listed so its switch stays reachable, but the daemon wires
none of its contributions up, so a card from one would advertise an add that fails. So a derived card exists
**iff** its capability is actually addable, third-party cards surface automatically, and the manifest is the
single source of a card's name/logo/fields/credential guide — nothing to drift.

Two things the core injects into a derived card rather than letting the manifest declare them, both because
a card that could restate them is a card that could get them wrong: the kind's **discriminator**
(`contributionDiscriminator()` — the `provider`/`platform` key pinned to the card's own id, which is what
traces a stored capability back to the card that made it), and the connected-computer **scope switches**
(the grant does not vary by OS, so two platform packs cannot drift on it and neither can a third-party one).
Contributed SKILL.md files get two substitutions on apply (`renderSkill()` in
[contributions.ts](_apps/sandbox/src/capabilities/contributions.ts)): `${id}` → the instance name, so a
host pack's examples read `mcp__my-laptop__run_command`; and `${tools}` → the kind's core tool-surface note,
which is core precisely because the same note duplicated across N packs is a note that drifts.

**Effects — what adding actually does, as data.** Kinds differ wildly in consequence (an extension runs
code with your session; a vpn bakes an image fragment with runtime directives; a cli connector just writes a
skill and stores a secret), so the consequences are a first-class taxonomy: the `CapabilityEffect` union, derived by
`capabilityEffects()` ([effects.ts](_libs/capability-catalog/src/effects.ts)) from kind + live config +
connector/extension contributions — the same data the handlers consume, so there is no per-card effects
list to maintain. It lives in the CATALOG, beside the cards that declare the same kinds, rather than in the wire
contract: nothing on the wire carries an effect, only the browser computes them, so a kind's user-facing story
(its card, its fields, what adding it does) is one package to open. A `Record<CapabilityKind, …>` table rather
than a switch, so a new kind is one entry with the same exhaustiveness the compiler enforced before. Rendered as
the "This will add to your sandbox" panel
([CapabilityEffects.vue](_apps/web/src/components/CapabilityEffects.vue)) before the add, as compact strips
on connected instances, and as grid badges for the consequential ones (image / runtime / trusted-code).

| Effect | Mechanics |
| --- | --- |
| `skill` | Writes `.claude/skills/<name>/SKILL.md`, auto-loaded by the agent next turn — per-instance for `cli`/`browser` (the instance id is the skill name), shared for `ssh`/`vpn`. |
| `secret` | `agent-env`: injected into the agent's environment each turn, never written to disk (`cli`). `disk`: a `0600` file or a denylisted manifest field (ssh key/password, WireGuard conf, git token). |
| `clone` | Git checkout into `.intentic/plugins/<id>` or `.intentic/extensions/<id>` (staged → pinned detached checkout → swap; tokens ride `GIT_CONFIG_*`, never the URL). |
| `image` | A Dockerfile fragment composed into the environment overlay — needs a one-time owner-run rebuild. |
| `runtime` | Privileged directives riding a core fragment — the ONLY source of container privileges (the base run is unprivileged): `vpn` → `NET_ADMIN` + `/dev/net/tun`, `docker` → `--privileged`. |
| `process` | Long-lived tmux-managed background processes (an extension's declared `processes`), restored on boot. |
| `mcp` | The manifest entry itself becomes an `mcp__<id>__` server the agent connects to next turn. |
| `scaffold` | Repos created in the workspace: `devops` → the intent + desired-state repos; `monorepo` → an empty pnpm+turbo repo named after the instance. |
| `deploy` | A managed `deploy.config.ts` entry; `service` also runs the shared infra-apply job now, `integration` applies on the next provision. |
| `trusted-code` | Extension code runs inside the app with the owner's session — owner-only, full-sha-pinned install; the trust decision of the system. |
| `profile` | A persisted logged-in Chromium profile under `.intentic/browser/<platform>`, established through the guided-login WebSocket (`/system/browser-login`) — the credential is a browser session, not a token. |

**Environment fragments have two trust tiers.** Core handler fragments (`vpn`/`browser`) are
code-authored and may carry privileged `# intentic:runtime` directives; extension/connector checkout
fragments are restricted to RUN/ENV instructions — the whole "what can an extension bake into the image"
security surface is `invalidExtensionFragment`
([fragment-sources.ts](_apps/sandbox/src/environment/fragment-sources.ts)). `composeEnvironment` folds
every active entry's fragments (a cli entry resolves its connector's fragment through the registry; an
extension entry its `contributes.environment`) into the overlay Dockerfile (`FROM` the base image), and an
owner-run rebuild applies it — until then the capability reads `pending` and the UI routes to the
Environment card.

The AGENT's half of that surface is the custom section, and it proposes into `.intentic/environment.d/` —
one `<tool>.Dockerfile` per thing it needs — rather than writing the proposal directly. Worktree-isolated
agents run in parallel, so a single shared proposal file would lose one of two concurrent drafts; naming each
draft for its tool also makes two agents needing ffmpeg converge on one entry. `readEnvironment` folds the
drafts plus the already-approved custom section into the one proposal the owner reviews (approval *replaces*
the custom section, so carrying it forward is what stops an approve from silently uninstalling everything
before it), and approve/reject clear the drafts. A `PreToolUse` hook
([agent-installs.ts](_apps/sandbox/src/agent/agent-installs.ts)) is what starts the flow: an image-scoped
`apt-get install`/`pip install`/`npm -g` is met with a one-per-turn note that the install dies with the
container and a draft is how it survives. It steers rather than blocks — project-scoped installs and venvs
are ordinary and are left alone.

Per-kind mechanics ([handlers/](_apps/sandbox/src/capabilities/handlers/)):

| Kind | On add |
| --- | --- |
| `devops` | Scaffolds the intent + desired-state repos (each its own operator panel) — the foundation `service`/`integration` require. Not removable. |
| `monorepo` | Scaffolds an empty pnpm+turbo repo named after the instance; apps are added from its operator panel. |
| `mcp` | Pure registration — no side effect beyond the manifest entry; `status` probes the URL. |
| `service` | Upserts an `i.want.service` entry into `deploy.config.ts`'s managed region and runs the infra-apply job, relaying its events. |
| `integration` | Upserts an `i.have.<provider>` backend entry; the secret (e.g. `STRIPE_API_KEY`) is read from sandbox env at provision time. |
| `cli` | Card-driven (data from `contributes.capabilities`): templates the connector's SKILL.md into `.claude/skills/<id>`, injects the credential into the agent's env each turn, optionally bakes a client-image fragment (psql, mysql, whisper). github/gitlab additionally run the core git-access hook (keypair registered to the account + an https credential, restored on every boot); `status` reports `pending` when that credential is missing, so the card can't read active while `git pull` fails. |
| `plugin` | Clones a Claude Code plugin repo into `.intentic/plugins/<id>`; the Agent SDK's loader reads its skills/agents/hooks/`.mcp.json` each turn. A marketplace repo (`.claude-plugin/marketplace.json`) can pre-fill the form. |
| `extension` | Owner-only, sha-pinned clone into `.intentic/extensions/<id>`, validated before swap (manifest parses, prebuilt entry exists, fragment RUN/ENV-only); starts declared `autoStart` processes. |
| `ssh` | Writes a per-machine Host block + `0600` key/password under `~/.ssh/intentic-hosts` (the /history-backed dir above) + the shared ssh skill; the instance id is the alias the agent uses (`ssh <id>`). |
| `vpn` | Stores ONE connection, discriminated by `provider` — `wireguard` (pasted `.conf`, `wg-quick`), `fortinet` (FortiGate SSL-VPN via `openconnect --protocol=fortinet`), `ipsec` (IKEv1/IKEv2 PSK + XAuth via strongSwan) — plus the shared vpn skill. Connecting is NOT part of the config: see [VPN](#vpn) below. |
| `docker` | The engine is baked into the base image, dormant; the fragment is a lone `--privileged` runtime directive (a cache-hit rebuild, not an install). Once privileged, runs `dockerd` in a persistent tmux session, restored on boot — so `pnpm db:up` works like a local dev machine. Not removable. |
| `browser` | Per-instance platform skill (rendered from the contributed pack); connecting is a guided live login (screencast over WebSocket) that persists the profile the agent's `@playwright/mcp` drives, headed on Xvfb with the stealth patch. This capability buys *identity*, not the browser itself: Chromium is baked into the base image and every turn already gets a credential-free `mcp__web__browser_*` server (`--isolated`, headless, no profile on disk), because reading a page is ordinary coding work. |
| `host` | A computer of the user's OWN, one capability per machine. Writes the contributed OS skill pack, then pushes the scope switches to the machine if it is up — an edit is a decision about what may happen on somebody's computer *now*, so it travels immediately rather than at the next reconnect. The machine connects itself out-of-band (the card's one-liner enrolls over `/system/hosts/enroll` and dials back); enforcement is on the machine, never here. |
| `agent` | An ACP agent as a chat provider. `apply`/`status` are a spawn + initialize probe, so a command that doesn't actually speak ACP is caught (with its stderr) before the first chat turn depends on it; the warm turn-serving connection lives in the acp pool. |
| `endpoint` | A model API the user pointed us at. `apply` and `status` are the SAME probe and neither is fatal: adding an endpoint whose server isn't up yet is the ordinary case, so the entry is stored either way and the card carries the truth ("3 models" vs "no models" — the usual way an Ollama install disappoints its owner). |

### VPN

A VPN is the one capability whose *stored* form and *live* form come apart, so it is modelled as two surfaces
rather than one. **Adding** a VPN is an ordinary capability (`vpn`): credentials plus `autoConnect`, in the
manifest, per the table above. **Connecting** one is a runtime operation on the `/vpn` routes
([vpn.contract.ts](_libs/sandbox-contract/src/contracts/vpn.contract.ts),
[vpn/](_apps/sandbox/src/vpn/)) — because a single stored connection is dialled and dropped many times, its
result is far richer than a `CapabilityStatus` (assigned address, routed CIDRs, pushed DNS, uptime), and a
2FA-gated dial needs a per-attempt code that must never be persisted.

The design rule that makes this safe is that **a link's state is always read back from the OS** — `wg show`,
openconnect's pidfile plus `ip -j addr/route`, `ipsec statusall` — and never remembered by the daemon. So a
tunnel the agent dropped, one the operator dropped, and one whose gateway died all read identically, and a
daemon restart observes the truth instead of a stale guess.

Three protocols, one driver each, total over the provider union
([vpn-drivers.ts](_apps/sandbox/src/vpn/vpn-drivers.ts)) so a new arm on the contract is a compile error until
it is implemented:

| Provider | Client | Notes |
| --- | --- | --- |
| `wireguard` | `wg-quick` | The pasted `.conf` IS the connection; the dial is synchronous, so there is no client process to supervise. |
| `fortinet` | `openconnect --protocol=fortinet` | FortiGate SSL-VPN — what FortiClient's `<sslvpn>` connections speak. **openconnect, not openfortivpn**: it routes over tun instead of spawning `pppd`, so it needs exactly the `/dev/net/tun` + `NET_ADMIN` grant this capability already carries and no `/dev/ppp` (which the rebuild executors' runtime allowlist deliberately does not include). The password reaches it on **stdin**, never argv, so it is absent from `ps` and from disk. |
| `ipsec` | strongSwan | IKEv1/IKEv2 with a PSK and optional XAuth — FortiClient's `<ipsecvpn>` connections, aggressive mode included. Each connection is its own pair of files under `/etc/ipsec.d/intentic`, which `/etc/ipsec.conf` and `/etc/ipsec.secrets` `include`, so one tunnel is written and torn down without regenerating the others. |

All three ride **one** environment fragment rather than one per protocol: adding a second kind of VPN later must
not cost a second container rebuild, and the runtime directives must appear exactly once in the composed
overlay (rebuild.sh appends each directive token it reads without deduplicating, so a doubled `--device` would
fail the run).

**The agent drives the same routes the browser does.** `/usr/local/bin/vpn`
([bin/vpn](_apps/sandbox/bin/vpn)) is a thin client over `/vpn`, taught by the shared `vpn` skill, so a tunnel
the agent dials appears in the operator's UI with nothing synchronising the two — there is one implementation
of what connecting means. It authenticates with a per-boot token from `/run/intentic/agent.token`
([agent-token.ts](_apps/sandbox/src/auth/agent-token.ts)) that `app.ts` admits **only** to `/vpn`: the agent
may dial and drop the tunnels the owner configured, and can never read the credentials behind them.

A user holding an exported FortiClient configuration imports it rather than re-keying endpoints
([forticlient-config.ts](_apps/sandbox/src/vpn/forticlient-config.ts)). Credentials in that file are wrapped in
FortiClient's machine-bound `EncX` encryption and are **not** recoverable, so every encrypted value is dropped
and reported as a field the user must supply — importing an unusable value would be worse than asking.

### Dependency islands: iq & lsp

Two recent subsystems are **agent-facing subprocess CLIs baked into the sandbox image** — the agent invokes
them by spawning a process, never by import:

- **iq** ([`@intentic/iq`](_apps/iq) + [`@intentic/iq-engine`](_libs/iq-engine) +
  [`@intentic/iq-recall`](_libs/iq-recall) + [`@intentic/iq-bench`](_tools/iq-bench)) — an agent-native
  workspace-search engine: a local index (SQLite) fused across lexical (ripgrep), structural (ast-grep),
  semantic (local embed + rerank), and git signals, rendered to a token-budgeted ranked answer. It replaces
  an agent's grep/find chains with one call. The **CLI** stays a subprocess (the agent's Bash calls), but the
  **engine library** is also linked into the daemon: `/workspace/search` runs a resident
  `createResidentEngine` instance in-process (index DB held open, sweep cached, revalidation driven by the
  workspace watcher), sharing the on-disk index with the CLI. Search is a **core editor feature**; iq is
  merely the interchangeable engine behind that route.
- **lsp** ([`@intentic/lsp`](_apps/lsp)) — an agent-facing TypeScript CLI (`lsp rename`, `lsp diag`) over the
  TS language service, advertised to the agent through a gated skill file. TypeScript/JavaScript only. Like
  iq, the CLI is a subprocess but the service is **resident**: `lsp daemon <root>` holds one warm
  LanguageService per tsconfig (sharing a document registry, so lib.d.ts is parsed once for the monorepo) and
  keeps the markers for edited files current on a debounce, exactly as VS Code's tsserver does for open
  buffers. Both callers — the agent's `lsp diag` and the daemon's post-edit hook
  ([agent-diagnostics.ts](_apps/sandbox/src/agent/agent-diagnostics.ts), which imports
  `@intentic/lsp/client`) — converge on one socket per repository. It matters because the cold path was
  ~0.8-1.3s per edit against this monorepo and the warm one is ~40-90ms, which is what makes checking after
  *every* edit affordable. The daemon is started by the first caller with a tsconfig above its file and exits
  after 15 min idle, so a workspace with no TypeScript in it never starts one.

## Scaling model & limits

Who pays for scale is a design decision, not an accident:

- **Compute is user-owned.** Every sandbox runs on the user's PC (`connect.sh`) or the user's server
  (the `workspace` provider). There is no intentic-operated fleet, scheduler, or capacity manager —
  agent turns, dev servers, and builds cost intentic nothing. (Corollary: `connect.sh` sets no
  `--memory`/`--cpus` caps; a runaway sandbox is the user's machine's problem.)
- **The platform is off the hot path.** The browser drives the daemon directly; the daemon announces
  its URL on boot (not a heartbeat — platform traffic is proportional to boot events, not sandbox
  count × a tick); the SPA is static files. Steady-state platform traffic per active user is roughly
  a `sandbox.list` every 30 s of navigation plus a plan check. The API is stateless with DB-backed
  sessions, so it scales horizontally; background jobs (retention sweep, tunnel pool top-up) take a
  Postgres advisory lock so replicas don't duplicate the work.
- **The one ceiling intentic owns is the shared Cloudflare account** behind intentic-provided
  tunnels: each such sandbox is 1 named tunnel + 2 DNS records (`sandbox-<id>`, `ssh-<id>`) + the
  port-forward slot pool's records (`PORT_SLOTS.length`, provisioned eagerly so forwards are instant),
  plus one record + ingress rule per panel preview — and preview routes have no per-panel teardown; they
  live until the sandbox is deleted or reaped (the reaper removes every CNAME pointing at a reaped
  tunnel, slots included). Cloudflare accounts cap out around 1000 named tunnels, plus
  per-zone DNS-record and API-rate limits shared by pool top-up, setup provisioning, preview minting,
  and the reaper. Mitigations in place: a daily reaper deletes tunnels idle > 7 days, the
  pre-provisioned pool absorbs signup latency, and provisioning is sequenced to stay under rate
  limits. Beyond ~1k concurrently-active intentic-path sandboxes the account must shard (or users
  bring their own Cloudflare, which shifts the entire cost to them).
- **Postgres stays small.** Workspace state (chat history, files, inventory, secrets) lives in the
  sandbox, never the platform — per-user platform data is a handful of rows. Hot-path columns are
  indexed and the connection pool is bounded per replica (`DATABASE_POOL_MAX`), so replicas × pool
  stays under `max_connections` by configuration, not luck.

## The intent contract

A local `deploy.config.ts` (see [_tools/examples/deploy.config.ts](_tools/examples/deploy.config.ts)) must
`export const intent = defineIntent(...)`; `resolve` derives the desired state from it
([resolve.ts](_apps/cli/src/resolve/resolve.ts)). `defineStack(...)` is the one-shot,
single-graph form used when a single deterministic graph is wanted directly.

## Conventions (so the layout is predictable)

- **One concept per file**, named for the concept (`reconcile-loop.ts`, `resolve.ts`,
  `forgejo-api.ts`). Tests are **co-located** next to their source.
- **Test naming:** `*.test.ts` = unit; `*.engine.test.ts` = integration driven through the real engine;
  `*.e2e.test.ts` = gated real run against live services. A gated suite does not hand-roll its gate — it
  declares the switch and the credentials it needs with `e2eTier` ([_libs/testing/src/e2e.ts](_libs/testing/src/e2e.ts))
  and stands down, saying which variable it wanted, when the environment is short of one. See
  [What each tier needs](#what-each-tier-needs).
- **Tiers:** `_libs/` = libraries, `_apps/` = runnable products, `_tools/` = shared config + repo-wide
  maintainer scripts (`_tools/scripts/`). The pnpm-workspace glob is `_*/*`. App-specific scripts live in
  that app's `scripts/` dir (e.g. `_apps/sandbox/scripts/`); the user-facing connect/sync/cleanup scripts
  are tracked site assets in `_apps/site/public/scripts/`, served at intentic.dev vanity URLs by
  [worker.ts](_apps/site/worker.ts).
- **Imports:** import from the true source (no re-exports/aliases). The `@intentic/src` package export
  condition resolves workspace imports straight to `src/`, so agents can edit across packages without
  building.
- The compiled shape of the example/fixture is pinned by
  [_libs/sdk/src/deploy.config.test.ts](_libs/sdk/src/deploy.config.test.ts) against
  [_libs/sdk/src/__fixtures__/deploy.graph.ts](_libs/sdk/src/__fixtures__/deploy.graph.ts).

See [CLAUDE.md](CLAUDE.md) for the code-style rules every change must follow.

## Local end-to-end testing

`createProviders()` ([_libs/providers/src/providers.ts](_libs/providers/src/providers.ts)) assembles the
full `ResourceType → Provider` map — the single seam between a compiled graph and execution. Passing
fakes drives the whole suite in-memory ([suite.engine.test.ts](_libs/providers/src/suite.engine.test.ts));
passing nothing uses the real SSH/Cloudflare/Forgejo/Komodo implementations.

[cli.e2e.test.ts](_apps/cli/src/cli.e2e.test.ts) is a **manual, real** run that drives the actual CLI
exactly as an operator would. It boots a Docker-in-Docker "host"
([_tools/dind-host/Dockerfile](_tools/dind-host/Dockerfile)) via `testcontainers`, scaffolds with `init`, authors a
`deploy.config.ts` pointed at the host's mapped SSH port (with a per-run generated key), fills
`desired-state/.env`, then runs `resolve` + `apply`. Phase 1 stands up the platform (Forgejo + its Actions
runner + Komodo + the workspace sandbox) and exposes `git.<zone>`/`deploy.<zone>` through a **real
Cloudflare tunnel**; phase 2 pushes a
tiny Dockerfile and authors an environment so `apply` wires CI/CD — the Forgejo Actions workflow builds +
pushes the image and Komodo rolls it out live at `app.<zone>`. It asserts the platform containers are up,
the public URLs respond, and the app serves its body, then purges the Cloudflare DNS + tunnel it created.

It is gated behind `INTENTIC_E2E` **and `CLOUDFLARE_API_TOKEN`** — both, so the suite stands down rather than
fails wherever its live credentials are absent, which is what lets the nightly CI job (`e2e:nightly`) run
`pnpm e2e` unconditionally and get whatever the pipeline's variables unlock. It is excluded from `pnpm test`
either way. Run it from the repo root with `pnpm e2e` — turbo builds the libs (`^build`) and each package's
e2e script sets the switch. That command asks **every** gated tier to run, and the ones you hold no
credentials for stand down; you supply only a Cloudflare token here (and, optionally, the zone to deploy
under). The host SSH key is generated per run, and the Forgejo/Komodo admin passwords are intentic-generated:

```sh
CLOUDFLARE_API_TOKEN=...        # Account → Tunnel → Edit; Zone → DNS → Edit; Zone → Zone → Read
CLOUDFLARE_ZONE=example.com \   # a zone you own — DNS records + a tunnel are created and then deleted
pnpm e2e
```

> Networking: providers run nested containers with `--network host`, so the engine reaches services at
> the host's internal IP and port. This works from a Linux/WSL2 host (routable bridge IPs); on Docker
> Desktop (macOS/Windows) run the harness as a sibling container on the same network.

### The hermetic tier (no secrets, runs on every MR)

[hermetic.e2e.test.ts](_apps/cli/src/hermetic.e2e.test.ts) covers the deployment path that actually
breaks in the field — the **derived** Forgejo + runner + Komodo control plane coming up on a real Docker
host — with zero external dependencies. Two existing seams make it hermetic: an authored `zone` in
`i.have.cloudflare` resolves the artifact fully offline (the dummy token is never sent anywhere), and
`apply --target host-git,host-git-runner,host-deploy` reconciles a slice whose inputs reference nothing
but the host (pinned by a contract test in [_libs/sdk/src/index.test.ts](_libs/sdk/src/index.test.ts)).
The suite boots the same DinD host, then asserts: offline resolve derives the platform nodes; the targeted
apply converges with the real engine-level SSH readiness gate; a second apply is all-noop; `adopt
--baseUrl http://<host>:<mapped-3000>` pushes the intent + desired-state repos into the real Forgejo and
sets the Actions secrets, idempotently; and a reproduced readiness failure (the service healthy on
localhost but its `internalUrl` firewalled — the field failure class) prints the SSH diagnostic sweep
(`readinessDiagnostics` in [_libs/providers/src/core/ssh-diagnostics.ts](_libs/providers/src/core/ssh-diagnostics.ts):
docker state, the node's logs, listeners, addresses, one verbose probe) before the
`ReadinessTimeoutError` propagates. The same sweep runs on any real `intentic deploy apply` readiness timeout.

Run it locally with `pnpm e2e:hermetic` (privileged local Docker, Linux/WSL2). In GitLab CI it runs on
every merge request as a **non-blocking** sidecar (`e2e:hermetic` job, `allow_failure: true`), pulling
the published `dind-host:latest` image (falling back to building [_tools/dind-host](_tools/dind-host)) and uploading
the CLI run logs as artifacts on failure. In the field `adopt` needs no flag at all — its default
transport is an SSH port-forward to Forgejo on the host (public DNS never enters the path); `--baseUrl`
remains an explicit transport override for reaching Forgejo over an already-mapped address like this test's.

### What each tier needs

`pnpm e2e` asks every gated tier to run at once, which only works because a tier that cannot reach its
service stands down instead of failing. Each declares its own requirement with `e2eTier`
([_libs/testing/src/e2e.ts](_libs/testing/src/e2e.ts)) — the opt-in switch it reads, and the credentials it
is useless without:

| Tier | Suite | Needs beyond a Docker daemon |
| --- | --- | --- |
| sandbox-daemon | [sandbox.e2e.test.ts](_apps/sandbox/src/sandbox.e2e.test.ts) | nothing |
| cloudflare | [cli.e2e.test.ts](_apps/cli/src/cli.e2e.test.ts) | `CLOUDFLARE_API_TOKEN` (+ `CLOUDFLARE_ZONE` to pick the zone) |
| discord | [discord.e2e.test.ts](_apps/sandbox/src/discord.e2e.test.ts) | `DISCORD_E2E_BOT_TOKEN` + `_SENDER_TOKEN` + `_CHANNEL_ID`; `ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` unlocks the real-agent-turn spec |

A tier that is asked to run and finds a credential missing puts the variable's name in its own suite title,
which is what vitest prints beside the `↓` — so the nightly's log states which tiers ran without anything
logging it. Widening the nightly is adding a protected CI variable, not editing a job. The credentials a
tier declares and the `passThroughEnv` list on turbo's `e2e` task are the same statement written twice: a
variable absent from `turbo.json` never reaches the suite, however CI is configured.

Two tiers deliberately sit outside that command, each under its own turbo task, and neither declares
credentials because neither needs any:

- **hermetic** ([hermetic.e2e.test.ts](_apps/cli/src/hermetic.e2e.test.ts), `pnpm e2e:hermetic`) — needing no
  secrets at all is exactly what earns it a run on every merge request rather than nightly, so it reads its
  own switch and must not wake with the gated ones.
- **browser** ([_tools/e2e](_tools/e2e), `pnpm e2e:browser`) — a dev-machine tier. Its whole stack answers on
  `localhost`, and every CI job here drives a docker-in-docker *service* that publishes ports on its own
  namespace, so sharing the `e2e` name only ever swept it into a nightly it could not pass.

## Demo

`pnpm demo:up` / `demo:down` / `demo:clear` ([_apps/cli/src/demo.ts](_apps/cli/src/demo.ts)) drive the
real CLI (`init`/`resolve`/`apply`) against a Docker-in-Docker "host", standing up Forgejo + Komodo behind
a Cloudflare tunnel so the result can be browsed. It is a **maintainer tool**, not a zero-setup demo: it
provisions against a real Cloudflare zone (`CLOUDFLARE_ZONE`, default `intentic.dev`) using
`CLOUDFLARE_API_TOKEN`, and shares the tunnel name `intentic-host` with the e2e harness (don't run both at
once).

- **`demo:up`** boots the privileged host (SSH on `DEMO_SSH_PORT`, default 2222), scaffolds with
  `init --link`, runs resolve + apply, seeds a test app, and leaves everything running — printing the
  public URLs (`git.<zone>` / `deploy.<zone>` / `app.<zone>`), the local URLs, and the generated admin
  logins. State is persisted in `.demo/state.json` so teardown can always find what it created.
- **`demo:down`** stops the host container but leaves the Cloudflare tunnel + DNS in place, so the next
  `demo:up` reconnects in seconds.
- **`demo:clear`** also purges the tunnel + DNS records the demo created.
