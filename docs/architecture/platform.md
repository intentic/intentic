# The platform, and what it is allowed to know

The hosted plane — sign-in and the sandbox registry — the line between it and the product, and what happens
as the fleet grows.

## Control plane vs application plane

Every need carries a `plane`: its role, independent of where it runs ([needs.ts](../../_deploy/need-resolver/src/needs.ts)):

- **Control plane**, the deploy machinery: `source-control` + `docker-registry` (Forgejo by default,
  GitHub/GitLab when declared) and `infra-control` (Komodo, on every stack): git/CI plus the deploy
  orchestrator. The local `intent` repo
  (`deploy.config.ts`) and `desired-state` repo (the artifact + execution status) drive it: `intentic
  resolve` runs the flow above and writes the artifact, `intentic deploy apply` executes it. A remote, PR-managed
  control plane (a standalone Forgejo watching the intent repo) is a planned later evolution of this same
  flow. ([_deploy/cli/src/resolve/resolve.ts](../../_deploy/cli/src/resolve/resolve.ts), [artifact.ts](../../_deploy/cli/src/lib/artifact.ts),
  [app.ts](../../_deploy/cli/src/app.ts))
- **Application plane**, what actually serves an app: its `deployment-target` (the app's runtime on the
  host) and its `domain` (the Cloudflare tunnel + DNS routes). Both are *derived from* `i.want.app` and
  emitted alongside the control-plane stack. ([_deploy/state-resolver/src/resolvers/platform.ts](../../_deploy/state-resolver/src/resolvers/platform.ts),
  [_deploy/providers/](../../_deploy/providers/src/))

The whole per-host support stack is self-contained: its control-plane Forgejo is just another reconciled
node, so `apply` needs no pre-existing control plane. A future remote control plane would reuse the same
`forgejo` provider: a different node instance, not a different implementation.


## Scaling model & limits

Who pays for scale is a design decision, not an accident:

- **Compute is user-owned past the starter.** Every sandbox but one shape runs on the user's PC
  (`connect.sh`) or the user's server (the `workspace` provider): no scheduler, no capacity manager, and
  agent turns, dev servers and builds cost intentic nothing. The exception is the **hosted starter**, the
  machine a browser arrival is given (Fly, one microVM per sandbox), which intentic does pay for: it is
  bounded by an hour allowance per account and by the idle-stop that puts it to sleep the moment nobody is
  connected, and it is the rung a user leaves the moment they want power rather than convenience. It is
  bounded a third way, by the provider: a Fly org's machine allowance is finite, so the platform counts its
  own fleet — sandboxes, warm stock, builders — against `HOSTED_MAX_MACHINES` and treats running out as a
  fact to state rather than a failure to report. The setup page says there are no machines free and points at
  the rung that runs on the reader's own computer, the warm pool stops prewarming so the last slots go to
  people, and the admins are mailed, because raising an allowance is a person's job
  (`_platform/api/src/sandbox/hosted/hosted-capacity.ts`). (Corollary: intentic sets no `--cpus` cap;
  a sandbox that saturates the CPU is the user's machine's problem. Memory is the one exception, and it
  is a narrow one: the local shape carries a `--memory`/`--memory-swap` cap, because user-owned compute
  still means a runaway build must not be able to take the user's desktop down with it, and a cgroup is
  the only thing that can stop it in time. It is a **share** of the machine, not a number — 35% held
  between 4 and 24 GiB, so two sandboxes fit on any host big enough for two (`localSandboxMemory`,
  `_shared/sandbox-run/src/index.ts`). The measurement rides for free: `intentic sandbox run-command`
  answers from inside an uncapped probe container the flow was already starting, where `/proc/meminfo`
  reports the docker engine's own total. Hosted shapes opt out via `init: false` and own their sizing.)
- **The platform is off the hot path.** The browser drives the daemon directly; the daemon announces
  its URL on boot (not a heartbeat: platform traffic is proportional to boot events, not sandbox
  count × a tick); the SPA is static files. Steady-state platform traffic per active user is roughly
  a `sandbox.list` every 30 s of navigation plus a plan check. The API is stateless with DB-backed
  sessions, so it scales horizontally; background jobs (retention sweep, the zone's DNS sweep, hosted-pool
  top-up) take a Postgres advisory lock so replicas don't duplicate the work.
- **The one ceiling intentic owns is the edge** user-run sandboxes are reached through: `@intentic/ingress`
  ([_platform/ingress](../../_platform/ingress)), N stateless machines on Fly behind anycast addresses. Intentic
  operates no host in that path any more, so the limit is no longer one home server's uplink and its overlay
  router's connection table. It is metered vendor bandwidth (~$0.02/GB out of North America and Europe) that
  grows by adding machines, which makes the scaling question a bill and a region's capacity rather than a
  saturated link nobody else can relieve. And a sandbox's registration is a live connection rather than a row,
  so tunnels re-establish themselves against whichever machine answers next. A tunnel lands on the machine
  nearest the sandbox and a browser on the machine nearest itself, so the machines tell each other what they
  hold and hand a request across the private network to the one that has it — a hop the owner at home never
  takes, since anycast puts their laptop and their browser on the same machine
  ([_platform/ingress/src/cluster.ts](../../_platform/ingress/src/cluster.ts)). Hosted sandboxes do not count
  against that ceiling at all: their bytes go from Fly's proxy to their own machine, and the edge is asked
  once per hostname per cache TTL for a routing decision. Their bill is the machine's own egress.
  A sandbox still costs ZERO DNS records: one wildcard record and one wildcard
  certificate (issued and renewed over DNS-01, $1/mo) serve every hostname. That is what replaced a shared
  Cloudflare account where each sandbox held ~10 records against a per-zone cap, and a full zone answered
  every new setup with error 81045. Nothing accumulates to sweep, either: reachability is a signature the
  platform mints, so there is no account anywhere to reconcile on a nightly pass. Two things keep bytes off
  the meter — a sandbox on the same machine as its desktop agent syncs over loopback instead of through the
  edge, and users who publish their own sandbox under their own domain don't touch it at all.
- **Postgres stays small.** Workspace state (chat history, files, inventory, secrets) lives in the
  sandbox, never the platform: per-user platform data is a handful of rows. Hot-path columns are
  indexed and the connection pool is bounded per replica (`DATABASE_POOL_MAX`), so replicas × pool
  stays under `max_connections` by configuration, not luck.
