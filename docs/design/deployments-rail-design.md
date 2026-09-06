# Deployments on the rail: the design

Why the `Deployments` rail view is shaped the way it is: a capability-driven tile over the Komodo connector,
in the shape `ext-pipelines` established for CI. Built as `@intentic/ext-deployments` plus the daemon's
`/komodo/{capability}` routes; this records the reasoning, and section 9 records what changed on the way.

## 1. The gap

The rail can already tell you **CI went red**. It cannot tell you **production went down**.

Three surfaces touch deployment today and none of them closes that:

| Surface | Gated on | Badges? | Subject |
| --- | --- | --- | --- |
| `Infrastructure` (core view) | the intent repo | never | declaring and provisioning |
| `Live status` (core view) | the desired-state repo | never | *plan vs reality*: drift from what you declared |
| `Pipelines` (ext) | a github/gitlab connector | **yes**, `danger` | CI runs |

Two problems, and they compound.

**`live` is not health.** `Live status` reads deployments through `intentic deploy deployments`, whose
`live` flag means *"Komodo has this deployment registered"*: the `DeploymentSchema` comment says so, and
adds that *"runtime detail (logs, container status) lives in Komodo's own UI: deep-linked"*. A container
that is exited, crash-looping, or sitting on an unreachable host reads `live: true`. The one screen a user
would reach for during an outage is the one that will tell them everything is fine.

**Everything is gated on repos, not on the connection.** Both infra views require an intentic-managed
intent/desired-state repo. Someone who connects the new Komodo connector: a user who already runs Komodo
and just wants their agent on it: gets an agent that can drive deployments and a rail that never mentions
them. `Pipelines` already showed the fix: gate on the capability, not the repo.

## 2. The rule this rail already follows

Worth restating before proposing anything, because it kills most of the obvious ideas.

> A badge must mean something happened here that you don't already know about, never *here is a statistic*.
>: `_extensions/maintenance/src/attention.ts`

`ciStreaks.ts` is the worked example, and it is emphatic: a count of failed runs is a **level**, and on a
repo measured at 75 failures in its last 100 pipelines the tile is simply always lit, which *"says nothing
a user can act on and trains them to stop looking"*. So it counts **edges**: the moment a branch went red,
once: and stays quiet however many further runs fail behind it.

Three consequences carry over intact:

1. **Edge, not level.** Badge the transition into broken, never the fact of being broken.
2. **Clears by looking, not by fixing.** Opening the view acknowledges what is on screen. The problem stays
   visible inside the panel; the rail just stops repeating itself.
3. **`danger` is rare on purpose.** Exactly one tile claims it today. Its value is its scarcity.

## 3. What to badge

The naive version (*count deployments not in `running`*) is the 75-of-100 trap verbatim. A deployment
stopped on purpose lights the rail forever, and the number is a level.

The good news is that **Komodo already keeps the edge record**: `read/ListAlerts` returns
`{ts, resolved, level, target, data, resolved_ts}`, where `data` is a tagged union that includes
`ContainerStateChange {name, server_name, from, to}`, `StackStateChange`, `ServerUnreachable`,
`Deployment/StackImageUpdateAvailable`, `BuildFailed`, `ProcedureFailed`, `ActionFailed`. That is
a durable, server-side, timestamped list of transitions with a `resolved` flag: precisely what `ciStreaks`
had to derive by hand from a runs list. **The badge needs no local history at all.**

An incident is an alert that is **unresolved** and **`ts > seenAt`**. Tiers, highest wins, one badge only:

| Tone | What earns it | Why |
| --- | --- | --- |
| `danger` | `ServerUnreachable` · `ContainerStateChange`/`StackStateChange` into `exited`/`dead`/`restarting` · `BuildFailed`/`ProcedureFailed`/`ActionFailed` | Something that was up is down. Ranked with the server first: an unreachable host explains every deployment on it, and saying "6 deployments down" when the truth is "one host is gone" is a worse answer. |
| `warning` | `ServerCpu` · `ServerMem` · `ServerDisk` | Real, but thresholds, and they flap. A disk about to fill is the one worth knowing before it becomes a `danger`. |
| `info` | `Deployment/StackImageUpdateAvailable` · `ResourceSyncPendingUpdates` | An opportunity, not a breakage. Never `danger`: a routine version bump must not spend the colour that means production is down. |
| *silent* | `AutoUpdated` · `ScheduleRun` · `Test` · `None` · every `resolved` alert | Nothing happened *to* the user. A resolved `ContainerStateChange` back into `running` is the recovery: it clears, it does not badge. |

**Komodo itself unreachable** gets its own treatment: it is badged once, on the transition, as `warning` with
a `mark` and no count (one fact, one click: the `ViewBadge.mark` case), and it must never read as `danger`.
"We cannot see production" is not "production is broken", and the pipelines poller makes the same distinction
when it leaves the last known state standing rather than blanking the tile.

**Tooltip names the thing when there is one of it.** Straight from `streakTooltip`: *"'main is broken' is a
fact the user can act on and '1' is not."* So: `Deployments · api exited on prod-1` beats `Deployments · 1`.

`seenAt` lives in the extension's own `api.settings` (persisted daemon-side, shared across the owner's
browsers), keyed by capability id so two Komodo connections keep separate read state.

## 4. What the view shows

Ordered by what an operator reaches for, worst-first. Nothing below the fold that an outage needs.

```
┌────────────────────────────────────────────────────────────────────────────┐
│  Deployments                              komodo.example.com ↗   ⟳ 12s ago │
├────────────────────────────────────────────────────────────────────────────┤
│ ⚠  NEEDS YOU                                                               │
│  ● prod-1 unreachable · 6m            [ Server ↗ ]  [ Ask the agent ]      │
│  ● api  running → restarting · 14m    [ Logs ]  [ Redeploy ]  [ Fix it ]   │
├────────────────────────────────────────────────────────────────────────────┤
│  14 running   2 down   1 restarting   3 updates available                  │
├────────────────────────────────────────────────────────────────────────────┤
│  prod-1   ⚫ unreachable        cpu ▇▇▇▇▁▁ 68%  mem ▇▇▇▇▇▁ 81%  disk ▇▇▇▇▇▇ 94% │
│    ● api        restarting   ghcr.io/acme/api:1.4.2        Restarting (3) │
│    ● worker     exited       ghcr.io/acme/worker:1.4.2     Exited (1) 20m │
│  prod-2   ● ok                 cpu ▇▇▁▁▁▁ 22%  mem ▇▇▇▁▁▁ 44%  disk ▇▇▁▁▁▁ 31% │
│    ● web        running      ghcr.io/acme/web:2.1.0 ↑new   Up 4 days      │
│    ● postgres   running      postgres:16                   Up 21 days     │
└────────────────────────────────────────────────────────────────────────────┘
```

**a. The incident strip**: only rendered when there is something unresolved. It is the reason the badge lit,
and it carries the buttons rather than making you find the row.

**b. One summary line**: `running / down / restarting / updates available`. The same job Pipelines' summary
counts do: answer "is anything wrong right now" before you read anything.

**c. The list, grouped by server: not by resource type.** This is the highest-value framing decision in the
design and it is where Komodo's own UI (which groups by Stacks / Deployments / Servers) reads worst during an
incident. The question an operator has at 2am is *"is this one app, or is it the box?"*, and grouping by host
answers it in the layout instead of making them correlate it themselves. The server row carries state plus
cpu/mem/disk, all of which arrive free in `ListServers`'s `info.stats`, and which explain a large share of all
deployment failures.

**d. Per row**: name · state chip · `image:tag` (with an `↑new` chip when `info.update_available`) · Komodo's
own status string (`Up 4 days`, `Exited (1) 20 minutes ago`), which is better prose than anything we would
generate. Stacks and deployments share the row; a stack expands to its services.

## 5. What you act on

Read-only would waste the surface. Six actions, all one round-trip to `execute/*`:

| Action | Call | When |
| --- | --- | --- |
| **Logs** | `read/GetDeploymentLog` / `GetStackLog`, tail 100 | always: expands inline, no navigation |
| **Redeploy** | `execute/Deploy` / `DeployStack` | always |
| **Restart / Stop / Start** | `execute/RestartDeployment` / `StopDeployment` / … | always |
| **Pull & deploy** | `execute/PullStack` then `DeployStack` | when `update_available`: the most common routine op, and today it is four clicks in another tab |
| **Open in Komodo** ↗ | deep link | always: we do not reimplement Komodo, we get you there |
| **Ask the agent to fix** | seeds a conversation | on any incident row |

**"Ask the agent to fix" is the one thing Komodo's own UI structurally cannot do**, and it is the reason this
view is worth building rather than iframing Komodo. `POST /ci/fix` already established the pattern: seed a
conversation with the failure plus enough log tail to see the actual error (CI uses 24 KB, *"enough to see the
error, small enough that the turn's context stays about fixing rather than scrolling"*). Komodo can restart a
container. This app can restart it, read the logs, find the bug **in the repo that is open in the next tab**,
fix it, and push. That is the whole product thesis on one button.

## 6. The one honest cost

The connector was pure data: a manifest entry and a skill. **This is not.**

The extension host reaches the daemon through declared `permissions.sandbox` route globs; it cannot call a
user's Komodo directly, and it must not: the API secret lives in the capabilities manifest and never enters
the browser. That is the product's core promise, not an implementation detail. So this needs daemon routes,
exactly as `/ci/runs` exists for the same reason.

It is meaningfully smaller than the CI backend, though, because Komodo hands us what that one had to build:

- **no webhook receiver**: the alert log is the record, and the Alerter→automation path already covers push
- **no vendor abstraction**: one API, not GitHub *and* GitLab
- **no runs cache**: Komodo is the cache

Leaving roughly: an api-key-authenticated client (the existing `_deploy/providers/src/komodo/komodo-api.ts` is
JWT-and-engine-shaped, so this is a sibling, not a reuse), one `GET /komodo/overview` fanning
`ListDeployments` + `ListStacks` + `ListServers` + `ListAlerts`, an actions route, a logs route, and a fix
route. Call it one focused daemon module plus the extension.

## 7. The seam with `Live status`

Two tiles about deployment need a defensible line, and there is one:

- **`Live status`: "does reality match what I declared?"** The planned graph, reconcile verdicts, drift,
  orphans. Its subject is *intent*. It stays gated on the desired-state repo.
- **`Deployments`: "is what is running healthy, and what changed?"** Runtime state, incidents, actions.
  Its subject is *operations*. Gated on the connector.

A user with both sees both, and the rows cross-link. The follow-on worth taking afterwards is letting
`Live status`'s "Running now" column defer to this data instead of its own `live` boolean: at which point
that column stops being able to say a crash-looping container is fine.

## 8. What I would cut

- **A metrics/graphs tab.** SigNoz is already a connector and does it properly.
- **Editing deployment config.** `write/*` from a dashboard is how you get drift that the desired-state repo
  then fights. Config belongs in Komodo or in the intent repo.
- **A count badge on `update_available` alone.** It is a level, it is never zero for long on an active
  registry, and it would relight the tile daily for something nobody needs to see today.
- **Per-deployment notification settings.** Komodo's Alerter already has whitelist/blacklist/type filters.
  Sending users to configure alerting in two places is worse than sending them to one.

## 9. What the build changed

Three things came out differently from the sketch above, each because the code made the answer clearer:

- **One tile per connection, not one tile.** `detect()` returns an activation per connected `komodo`
  capability, so two Komodos are two tiles with two independent `seenAt` stamps. Looking at staging must not
  silence production: which also pushed the seen-state store from one timestamp to a map keyed by capability
  id (`.intentic/local/runtime/extensions/deployments/komodo.json`).
- **`exited` is neutral in the list and a breakage in the alert.** A container sitting exited says nothing
  (it may have been stopped on purpose); a container that *transitioned into* exited stopped while it was
  meant to be running. The state table and `BROKEN_STATES` disagree on that word deliberately, and that
  disagreement is the level/edge distinction made concrete. `komodo-overview.test.ts` and `incidents.test.ts`
  pin both halves.
- **The overview degrades rather than throws.** An unreachable Komodo resolves with `reachable: false` and a
  reason instead of erroring, because the single most important thing this view can say is "I cannot see
  production", and it can only say it by rendering. Actions still propagate their failures as `BAD_GATEWAY`
  carrying Komodo's own words: a refused deploy is an answer the operator needs verbatim.

The `km` CLI is still not bundled, so the connector still carries no image effect and still needs no rebuild.
