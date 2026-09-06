import { z } from "zod";
import { AgentSummarySchema } from "../schemas/agents.js";
import { AccountUsageSchema, ProviderRefusalSchema } from "../schemas/plan-limits.js";
import { MemberRoleSchema } from "../schemas/shared.js";

/* THE FRAMES THAT ARE ABOUT THE SANDBOX RATHER THAN ABOUT A TURN: the liveness heartbeat, where the daemon is
 * in its boot, what just moved (repos, refs, running processes, presence, the fleet), and an account's
 * headroom. The browser holds one stream open for all of them. */

// One parsed line from `intentic … --output ndjson` (engine events, provider `log`, the terminal `result`).
// Open-ended by design, the sandbox consumes the wire shape, not @intentic/engine's types, so a string
// `kind` plus arbitrary extra fields pass through. The apply-events tail (intentic.contract `applyEvents`) rides
// this same loose shape with three daemon/CLI-minted sentinel kinds alongside the engine ones: {kind:"start"}
// (first line, written when the run's file is reset), {kind:"exit",code} (last line, on the CLI process exit),
// and {kind:"heartbeat"} (interleaved by the tail while idle to keep the held-open stream alive).
export const IntenticLineSchema = z.looseObject({ kind: z.string() });
export type IntenticLine = z.infer<typeof IntenticLineSchema>;

/* The daemon's liveness heartbeat frame: the browser holds the events stream open and trips a watchdog if the
 * frames stop (the tunnel drops the proxied response when the origin dies).
 *
 * IT ALSO SAYS WHERE THE FLEET STANDS, and that one number is what makes the roster self-correcting. The
 * roster is otherwise push-only: the daemon frames it on every change (AgentsSchema) and the browser applies
 * what arrives, so a snapshot that never lands — dropped by the revision guard, applied into a store nothing
 * reads any more, lost with a frame the consumer never pulled — is a board frozen at that instant, silently,
 * until somebody reloads the page. That is the "the /agents view stopped moving while the chat kept working"
 * report, and nothing in the stream could tell the browser it had happened.
 *
 * A beat is only sent when this connection's queue is EMPTY (system.routes.ts), so by the time one is read the
 * browser has already applied every frame the daemon sent before it. `rev` disagreeing with what the browser
 * holds is therefore not a race, it is proof that a snapshot went missing, and the browser answers it with one
 * GET /agents (useAgents-registry's auditRoster). Costs nothing when nothing is wrong: the number rides a frame
 * that was already flying, and an agreeing beat does nothing at all. */
export const HeartbeatSchema = z.object({ kind: z.literal("heartbeat"), rev: z.number() });
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

// One step of the daemon's boot chain. `key` is the stable id the daemon declares it under, `label` the words
// the browser shows. A step that FAILED is still a step that finished, the boot chain is log-and-continue by
// design (see main.ts), so a failure degrades one subsystem rather than holding the gate closed forever.
export const BootStepSchema = z.object({
    key: z.string(),
    label: z.string(),
    state: z.enum(["pending", "running", "done", "failed"]),
    // Elapsed ms, once the step has finished.
    ms: z.number().optional(),
});
export type BootStep = z.infer<typeof BootStepSchema>;

/* WHERE THE DAEMON IS IN ITS BOOT. The listeners come up before the state they serve has converged (main.ts:
 * "listen first, converge behind the gate"), which is what stops a restart from reading as an outage, but it
 * also means the daemon spends the first seconds of every boot both reachable and unable to answer, and until
 * this frame existed the browser had no way to tell that apart from a healthy sandbox. It painted an operable
 * workspace off its persisted cache and then parked every request the user made against the readiness gate.
 *
 * The step list is declared UP FRONT and sent whole, pending entries included, so the browser can say "4 of 11,
 * loading the conversation registry" rather than "something is happening", a boot that takes minutes has one
 * slow step, and naming it is the whole point. Snapshot-not-diff, like every other roster on this stream. */
export const BootProgressSchema = z.object({
    // False only while the chain is still converging. The browser holds every daemon read until this is true.
    ready: z.boolean(),
    // Epoch ms the daemon started converging, so the browser can show a total elapsed that survives a reconnect.
    startedAt: z.number(),
    steps: z.array(BootStepSchema),
});
export type BootProgress = z.infer<typeof BootProgressSchema>;

// Pushed on every step transition and once more when the gate opens. Rides /events, which answers before the
// gate precisely so this can be delivered while everything else waits.
export const BootSchema = z.object({ kind: z.literal("boot"), ...BootProgressSchema.shape });
export type Boot = z.infer<typeof BootSchema>;

// The stream's first frame: the workspace's stable identity, minted at the first boot of an empty /work. The
// browser remembers it per sandbox id and drops that sandbox's persisted query cache when it changes, a wiped
// and recreated workspace (cleanup.sh + reconnect keeps the same sandbox id) must not be painted from the
// previous workspace's cache. `build` is the same guard against a different axis: the daemon's own compiled
// tree, so an image update (or a `pnpm build:sandbox` swap in dev) drops what the browser cached from the
// PREVIOUS build instead of hydrating payloads the new one no longer shapes that way.
//
// It also advertises `routes`, the contract route names (`vpn.list`, `kimi.models`) this daemon actually
// implements, from ITS build of the contract. A browser is routinely newer than the daemon it talks to (a
// released app plane serves whatever image each user last pulled; in local dev the web app is always ahead of
// the last `pnpm build:sandbox`), and that stays fully supported, the browser just compares the two sets so a
// route the daemon predates surfaces as a named, explained gap instead of a bare 404 nobody can attribute.
//
// `shapes` answers the half `routes` structurally cannot: a route BOTH builds have, whose payload changed
// between them. Names match, so nothing 404s, the call goes out and a field the browser expects is simply
// missing from the answer. It is a map of route name → a fingerprint of that route's input and output schema
// (see routes.ts), so a difference is a named route rather than "something, somewhere, moved". Beside `routes`
// rather than folded into it: existence covers every route, shape covers only the ones that can be expressed.
//
// Every added field is optional: a daemon built before one simply says nothing, and the browser's fallback is
// the pre-existing behaviour, routes all assumed present, shapes all assumed to agree, the daemon assumed
// ready, the cache left alone. That is also why `routes` keeps its bare-string-array shape: an image already in
// the wild sends exactly that, and a breaking change here would fail the hello frame's own parse and take the
// whole event stream down for precisely the skew this frame exists to describe.
export const HelloSchema = z.object({
    kind: z.literal("hello"),
    workspaceId: z.string(),
    routes: z.array(z.string()).optional(),
    shapes: z.record(z.string(), z.string()).optional(),
    build: z.string().optional(),
    boot: BootProgressSchema.optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

// The FULL discovered repo set (sorted root-relative ids), pushed whenever it changes, a clone, a scaffold,
// or a deleted repo re-frames it. The watcher descent-ignores .git, so no workspaceChanged path pattern can
// detect a repo appearing; the daemon diffs its own discovery instead. Snapshot-not-diff, last frame wins.
export const ReposChangedSchema = z.object({ kind: z.literal("reposChanged"), repos: z.array(z.string()) });
export type ReposChanged = z.infer<typeof ReposChangedSchema>;

// A batch of workspace paths that just changed on disk (created/edited/deleted), pushed on the same /events
// stream as the heartbeat so the browser refreshes the tree + any open file live, the agent edits files
// out-of-band (its own Write/Edit/Bash tools), so there's no HTTP mutation to hang an invalidate on. Paths are
// root-relative, forward-slash (the tree/file route space). An empty array means "something changed, refetch the
// tree", a burst too large to enumerate, or a reconnect recovery where we don't know what was missed.
export const WorkspaceChangedSchema = z.object({ kind: z.literal("workspaceChanged"), paths: z.array(z.string()) });
export type WorkspaceChanged = z.infer<typeof WorkspaceChangedSchema>;

/* THE REPOS WHOSE REFS JUST MOVED, a commit, a checkout, a branch or tag, a rebase started or aborted.
 *
 * A third push for the same reason as the two above, and the reason is structural: a repo's git dir does not
 * live under /work at all (it is relocated onto /history so an isolated turn's worktree can stand in for the
 * workspace root, see git/repo-git-dirs.ts), and the file watcher descent-ignores `.git` besides. So no
 * `workspaceChanged` path can ever say "a ref moved", and a surface built on the commit graph would otherwise
 * be exactly as fresh as the last thing the user clicked.
 *
 * It matters most for the work the user did NOT do: the agent commits, rebases and lands out-of-band, with no
 * HTTP mutation in any browser to hang an invalidation on. Ids are root-relative, "root" being the /work repo.
 * Diff-not-snapshot, unlike reposChanged: this names what moved, and a repo absent from a frame is a repo that
 * did not move rather than one that stopped existing. */
export const RefsChangedSchema = z.object({ kind: z.literal("refsChanged"), repos: z.array(z.string()) });
export type RefsChanged = z.infer<typeof RefsChangedSchema>;

/* WHICH RUNNING THINGS JUST MOVED, a session opened or exited, a dev server bound its port, a browser closed,
 * a subagent reported in.
 *
 * The fourth push, and the one that covers what the other three structurally cannot: none of this state is on
 * disk, so no `workspaceChanged` path can name it, and none of it is a ref or a repo. Before it, every view of a
 * running thing polled on its own timer, which is to say each browser asked, forever, a question only the
 * daemon could answer and almost always answered "no change".
 *
 * Diff-not-snapshot, and deliberately thin: the frame carries the DOMAIN that moved, never the roster itself.
 * Invalidation only reaches a query something is observing, so a tab showing none of these pays a frame and no
 * request, whereas a roster on the wire would bill every connected browser the full list whether or not
 * anything on screen renders it. Which query keys a domain stands for is runtime-state.ts's table. */
export const RuntimeChangedSchema = z.object({ kind: z.literal("runtimeChanged"), domains: z.array(z.string()) });
export type RuntimeChanged = z.infer<typeof RuntimeChangedSchema>;

// One connected browser tab of a sandbox member. Identity fields come from the caller's verified Google ID
// token; activity fields from the tab's own /system/presence reports. No timestamps on the wire, an entry's
// lifetime IS its /events connection's lifetime, so there is nothing to age out or compare clocks over.
export const PresenceUserSchema = z.object({
    // Per-CONNECTION id, minted by the browser for each /events attempt, never reused across reconnects.
    clientId: z.string(),
    email: z.string(),
    name: z.string().optional(),
    picture: z.string().optional(),
    // The caller's trust tier, resolved by the authorizer at connection time. On the roster so every member
    // can see who may do what, and so a tab knows its OWN role without an owner-only lookup.
    role: MemberRoleSchema,
    idle: z.boolean(),
    // Route/view name the tab is on ("workspace", "automations", "ext:<id>/<key>", …).
    view: z.string().optional(),
    // The chat conversation the tab has active.
    sessionId: z.string().optional(),
    // The workspace file the tab has open (root-relative, forward-slash).
    path: z.string().optional(),
});
export type PresenceUser = z.infer<typeof PresenceUserSchema>;

// The FULL roster of connected members, broadcast on every change, snapshots, not diffs, so a reconnecting
// browser is consistent from its first frame and ordering never matters (last frame wins).
export const PresenceSchema = z.object({ kind: z.literal("presence"), users: z.array(PresenceUserSchema) });
export type Presence = z.infer<typeof PresenceSchema>;

// The FULL fleet roster, broadcast on every registry change, same snapshot-not-diff contract as presence:
// a reconnecting browser is consistent from its first frame. NOT simply "last frame wins", though: `rev` is the
// registry revision the snapshot was taken at, and the browser applies a frame only if it is newer than the one
// it already holds. Snapshots race two other sources of the same fact, an explicit GET /agents and the
// browser's own optimistic writes, and an unordered full replace lets the slowest of them win, which is how an
// archived card came back. See AgentsListSchema and useAgents.ts.
export const AgentsSchema = z.object({ kind: z.literal("agents"), agents: z.array(AgentSummarySchema), rev: z.number() });
export type Agents = z.infer<typeof AgentsSchema>;

/* AN ACCOUNT'S HEADROOM JUST MOVED, the reading itself, keyed the way the daemon's store keys it (a Claude
 * account id, or `${provider}:${authFile}` for a routed subscription).
 *
 * The fifth push, and the one that lets every ring, rail and picker row stop refetching on mount. A reading
 * lands on the daemon for one of four reasons, a turn settled, a plan refused, a screen asked, a provider
 * pushed, and until this frame existed only the window that caused it ever heard: every other window drew the
 * number it had loaded that morning until something in it happened to remount. Snapshot-not-diff per account,
 * last frame wins, and a browser that missed one simply holds the older reading, which is what `measuredAt`
 * is for. `usage` absent ⇒ the account's snapshot was cleared (it was disconnected). */
export const AccountUsageChangedSchema = z.object({
    kind: z.literal("accountUsage"),
    // The provider whose row this account is, because the key alone does not say (a native id is bare).
    provider: z.string(),
    account: z.string(),
    usage: AccountUsageSchema.optional(),
});
export type AccountUsageChanged = z.infer<typeof AccountUsageChangedSchema>;

// A provider's last refusal was recorded or settled. The observed half of "can I run on this" (see
// ProviderRefusalSchema), pushed for the same reason the reading above is: a refusal at 4am used to reach a
// window only when it next reloaded its account rows. `refusal` absent ⇒ settled, nothing stands.
export const ProviderRefusalChangedSchema = z.object({ kind: z.literal("providerRefusal"), provider: z.string(), refusal: ProviderRefusalSchema.optional() });
export type ProviderRefusalChanged = z.infer<typeof ProviderRefusalChangedSchema>;

// The /events stream union: the hello identity frame, then liveness heartbeats interleaved with boot progress,
// workspace-change batches, repo-set snapshots, ref-move batches, runtime-domain nudges, presence + fleet
// roster snapshots, and account headroom / refusal changes. oRPC validates every yielded frame against this,
// so all kinds must live here.
export const SystemEventSchema = z.discriminatedUnion("kind", [
    HelloSchema,
    HeartbeatSchema,
    BootSchema,
    WorkspaceChangedSchema,
    ReposChangedSchema,
    RefsChangedSchema,
    RuntimeChangedSchema,
    PresenceSchema,
    AgentsSchema,
    AccountUsageChangedSchema,
    ProviderRefusalChangedSchema,
]);
export type SystemEvent = z.infer<typeof SystemEventSchema>;
