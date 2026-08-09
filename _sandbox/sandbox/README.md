# @intentic/sandbox

The **per-project AI-agent dev daemon** — a Docker image that runs as the project's workspace container on the customer's host. It exposes an HTTP API the browser drives **directly** over the sandbox's own Cloudflare tunnel (Google-backed renewable sessions): run a Claude Agent turn over the project's three repos, run the `intentic` CLI, do git operations, read/write inventory, and report the dev-server preview. Ships to GHCR as `ghcr.io/intentic/sandbox`. A private package (not published to npm).

## Responsibilities

- Serve the daemon API (`/agent`, `/intentic`, `/git/:repo/*`, `/inventory`, `/info`, `/preview`, `/health`); the browser calls it directly over the sandbox's tunnel, each request authenticated by a daemon session minted from verified Google identity (`/health` carved out for liveness).
- Run one Claude Agent turn (`runAgent`) over the workspace, streaming typed `AgentEvent`s as SSE `data:` frames.
- Run the `intentic` CLI in-workspace and stream its ndjson lines; commit/push the repos.
- Manage the app dev server and report preview status — including what is ACTUALLY answering inside the box: each
  listening port with the process that took it and the terminal that process descends from, whoever started it.
- Keep the tree true after lands: reinstall drifted dependencies, run the project's own checks, and announce the
  edges (`deps.broken`/`deps.fixed`) that wake the seeded fix chore — every step in a visible terminal panel and
  the activity feed (src/workspace/reconcile-deps.ts → verify-deps.ts → src/automations).
- Hold outbound posts as an approval queue: the agent proposes drafts as files (`.intentic/drafts/`, src/drafts),
  the owner approves them on the Drafts page, and the daemon fires the seeded publisher automation the moment a
  draft is approved and due — a future-dated approval waits for the publisher's sweep instead.
- Gate what runs without the owner, in two layers that share one decision seam (src/guard). Before a session
  starts: every outside-driven wake (automations, listeners, the Doorbell, the workflow release gate) is
  allowed, held for approval, or refused. Inside a session already running: classified outbound provider calls
  are checked against the owner's action rules, and shell commands whose class the owner holds — destructive
  git, recursive deletes, credential reads, publishes, outbound fetches — park on a permission card before they
  execute. Both in-turn gates are PreToolUse hooks, which is what makes them hold in the autonomous posture
  where the permission cards are never raised at all.
- Schedule workflow graphs daemon-side. A run snapshots every repository HEAD once, creates every fresh step
  from those exact commits, holds candidate branches instead of auto-landing them, and resumes workflow-owned
  loops through one coordinated restart path. At most four workflow graphs execute across a sandbox at once.

## Key files

- [src/app.ts](src/app.ts) — the Hono HTTP API: every route the browser and the CLI reach the daemon through.
- [src/agent](src/agent) — **singular**: one conversation. The turn loop, its tools, steering, terminals and diagnostics.
- [src/agents](src/agents) — **plural**: the fleet. The registry, `worktrees.ts`, `isolation.ts`, `land.ts`, `origins.ts`, `landed-presence.ts`.
- [src/git/git.routes.ts](src/git/git.routes.ts) — status/commit/push over the wire; [src/workspace](src/workspace) — the repo layout the daemon serves. [src/workspace/workspace-scope.ts](src/workspace/workspace-scope.ts) decides WHOSE copy a file read means: the shared `/work` tree, or one conversation's own checkout when the request names it (`?agent=`). Reads only — no write route can name a checkout — and a request naming one that was archived away says so specifically instead of reporting a missing file.
- [src/composition.ts](src/composition.ts) — what is wired to what; [src/main.ts](src/main.ts) — the entrypoint that builds it and serves.
- The two things that keep a busy sandbox from eating itself, both keyed on the fact that a child inherits from
  its parent without anyone propagating anything:
  [src/platform/workload-priority.ts](src/platform/workload-priority.ts) renices every direct child so the
  control plane outranks the work it started, and
  [src/platform/leftovers.ts](src/platform/leftovers.ts) stamps each one with WHOSE turn it is, so the provider
  CLI's MCP servers and their headless browsers — three levels down, and nothing here holds a handle on them —
  can be reclaimed once that turn has finished. Anything under a tmux pane is exempt: that has a watcher, and
  [src/terminal/terminal-session.ts](src/terminal/terminal-session.ts) ages it out on its own policy.
- The four change feeds that keep the browser fresh without it ever asking twice, all riding the one `/events`
  stream: [src/workspace/workspace-watch.ts](src/workspace/workspace-watch.ts) (files),
  [src/workspace/repo-watch.ts](src/workspace/repo-watch.ts) (the repo set),
  [src/git/ref-watch.ts](src/git/ref-watch.ts) (refs), and
  [src/system/runtime-watch.ts](src/system/runtime-watch.ts) — everything that is RUNNING rather than written:
  tmux sessions, panel dev servers, listening sockets, the agent's browsers and its subagents. The first three
  start from a file; the fourth cannot, which is why it is half announcements from the subsystems that do the
  thing and half one shared sampler that runs only while a browser is connected.
- [src/hosts](src/hosts) — the user's own computers: the socket each one holds open, the Computers view's data
  (`machine-reports.ts`), and `host-seed.ts` — the card the setup flow creates for the machine that installed
  this sandbox, granted its sandboxes and nothing else. Acting on one of those sandboxes STREAMS, because the
  slowest of those actions pulls an image for minutes; the scope behind it is checked on the machine and never
  here.
- [src/guard/guard.ts](src/guard/guard.ts) — the one gate every gated action consults (fail-closed); [src/guard/actions.ts](src/guard/actions.ts) is the catalog of decisions, and [src/guard/command-gate.ts](src/guard/command-gate.ts) is the one that can park a running turn on a card.
- [src/auth/role-floor.ts](src/auth/role-floor.ts) — the minimum trust tier per route, in one table. [src/auth/auth.ts](src/auth/auth.ts) resolves who a caller is (owner TOFU, members with granted roles); the floor decides what that tier reaches.
- [src/workflows](src/workflows) — workflow scheduling, immutable run snapshots, restart recovery, run-ledger
  retention, and complete handoff artifacts; [src/loops](src/loops) drives each individual step.

## How it fits

The agent half of the dev plane. The browser talks to this daemon **directly** over the sandbox's own Cloudflare tunnel; the daemon verifies Google identity when establishing a renewable session, resolves the Claude token from its **own** stored credentials, and injects it into the SDK per turn. The platform is never on this path and never contacts the sandbox — it only stores the sandbox's public URL (which the browser derived and wrote) so the browser knows where to reach it; the browser alone probes the daemon for liveness (`/health` + the `/events` stream).

## Conventions & gotchas

- Workspace-root daemon state has a lifecycle taxonomy: provider homes are secret under `.intentic/auth/`,
  resumable Claude state is carried under `.intentic/sessions/claude/`, rebuildable search state is under
  `.intentic/cache/`, durable attachments/browser captures/run evidence are under `.intentic/artifacts/`, and
  connector discovery state is derived under `.intentic/runtime/`. Small owner-edited manifests remain directly
  under `.intentic/` so their stable paths stay readable.
- The Claude credential lives in the sandbox's own `.intentic/auth/claude/` store (connected via the daemon's
  `/claude/*` flow), resolved + injected into the SDK per turn — never held by the platform. The generic file API
  protects the whole `auth/` parent, provider-native `sessions/`, and logged-in `browser/` profiles; purpose-built
  routes expose only the safe slices those stores need.
- The daemon authenticates every request itself (a Google ID token only at exchange, then a daemon-minted session verified per request), since it is reached directly over its public tunnel — it owns its own auth. Access is tiered: the owner binds on first sign-in, and every invited member holds a granted role (viewer / collaborator / maintainer) stored in `.intentic/members.json`. The bearer middleware holds each request to its route's floor (`src/auth/role-floor.ts`): viewers read, collaborators drive agents (their lands become requests on the agent card), maintainers ship and get the terminal, and credentials-adjacent surfaces stay owner-only. Rotating sessions or changing a member's grant closes that identity's live event, terminal, and browser transports and invalidates unused connection tickets. Account deletion retires browser authorization at the daemon before the platform record disappears; if the daemon cannot be reached, deletion stops and names the sandbox that still needs attention. The platform only mirrors the grants; this daemon is the enforcer.
- Built on Hono + the Claude Agent SDK + zod; `runAgent`'s `QueryFn` is injectable so co-located `*.test.ts` run without the SDK or network.
- There is more than one workspace, and a path alone does not say which. Every isolated conversation has its own checkout, so the same path names a different file in each — which is why the workspace read routes take an optional conversation and resolve the root in one place (`src/workspace/workspace-scope.ts`). A checkout is **not** a superset of `/work` (the mirrored dirs are bare mount points from outside the turn's namespace, and untracked workspace content was never in it), so a scoped read falls back to the shared tree and reports which one answered. Search is the stated exception: the iq index is built over `/work` and stays there.
- A land's product is **uncommitted** — it patches the main working tree and moves no commit. So every reading taken between two shas (`standing.ts`) is blind to the user discarding it afterwards; `landed-presence.ts` is the one that asks the working tree, and it is what keeps a card from claiming work is in a workspace that no longer holds it.
- Workflow run artifacts are shared state under `.intentic/workflow-runs/`. The JSON ledger retains every active
  run plus 50 ended runs and removes a run's artifacts when that record is evicted or forgotten.
- Archiving a finished agent preserves its transcript and parked branches while reclaiming checkouts. Explicitly
  purging the archive also removes the daemon transcript, unshared attachment UUID dirs, and separately-owned
  Claude session files; provider-native state that still shares an auth home is never guessed at destructively.
