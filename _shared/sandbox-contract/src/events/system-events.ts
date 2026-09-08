import { z } from "zod";
import { AgentSummarySchema } from "../schemas/agents.js";
import { AccountUsageSchema, ProviderRefusalSchema } from "../schemas/plan-limits.js";
import { MemberRoleSchema } from "../schemas/shared.js";

// Frames about the sandbox rather than a turn: liveness, boot progress, what moved (repos, refs, running processes,
// presence, the fleet), and account headroom. One stream carries them all.

// One parsed line from `intentic … --output ndjson`; open-ended, so any string `kind` plus extra fields pass through.
// The apply-events tail also mints `start`/`exit`/`heartbeat` sentinel kinds alongside the engine's own.
export const IntenticLineSchema = z.looseObject({ kind: z.string() });
export type IntenticLine = z.infer<typeof IntenticLineSchema>;

// Liveness heartbeat; the browser's watchdog trips if frames stop. `rev` is the fleet revision as of an empty send
// queue: a mismatch proves a dropped roster snapshot, and the browser re-fetches via GET /agents.
export const HeartbeatSchema = z.object({ kind: z.literal("heartbeat"), rev: z.number() });
export type Heartbeat = z.infer<typeof HeartbeatSchema>;

// One step of the daemon's boot chain; `key` is its stable id, `label` the words shown. A failed step still counts as
// finished: the boot chain logs and continues rather than holding the gate closed.
export const BootStepSchema = z.object({
    key: z.string(),
    label: z.string(),
    state: z.enum(["pending", "running", "done", "failed"]),
    // Elapsed ms, once the step has finished.
    ms: z.number().optional(),
});
export type BootStep = z.infer<typeof BootStepSchema>;

// Where the daemon stands in its boot; listeners come up before state converges, so it can be reachable yet unable to
// answer for a few seconds. The step list is sent whole, pending steps included, so the UI can name what's slow.
export const BootProgressSchema = z.object({
    // False only while the chain is still converging; the browser holds every daemon read until this is true.
    ready: z.boolean(),
    // Epoch ms the daemon started converging, so the browser can show elapsed time across a reconnect.
    startedAt: z.number(),
    steps: z.array(BootStepSchema),
});
export type BootProgress = z.infer<typeof BootProgressSchema>;

// Pushed on every step transition and once more when the gate opens; rides /events, which answers before the gate so
// this can be delivered while everything else waits.
export const BootSchema = z.object({ kind: z.literal("boot"), ...BootProgressSchema.shape });
export type Boot = z.infer<typeof BootSchema>;

// The stream's first frame: `workspaceId` and `build` key the browser's persisted cache, so a wiped workspace or new
// image doesn't hydrate stale data. `routes`/`shapes` turn a version-skewed 404 or missing field into a named gap.
export const HelloSchema = z.object({
    kind: z.literal("hello"),
    workspaceId: z.string(),
    routes: z.array(z.string()).optional(),
    shapes: z.record(z.string(), z.string()).optional(),
    build: z.string().optional(),
    boot: BootProgressSchema.optional(),
});
export type Hello = z.infer<typeof HelloSchema>;

// The full discovered repo set (sorted, root-relative ids), pushed on any change. The watcher ignores `.git`, so the
// daemon diffs its own discovery instead of detecting a new repo from a path. Snapshot, not diff.
export const ReposChangedSchema = z.object({ kind: z.literal("reposChanged"), repos: z.array(z.string()) });
export type ReposChanged = z.infer<typeof ReposChangedSchema>;

// A batch of workspace paths that changed on disk, root-relative forward-slash; the agent edits out-of-band so there's
// no HTTP mutation to hang an invalidation on. An empty array means refetch the whole tree.
export const WorkspaceChangedSchema = z.object({ kind: z.literal("workspaceChanged"), paths: z.array(z.string()) });
export type WorkspaceChanged = z.infer<typeof WorkspaceChangedSchema>;

// Repos whose refs moved (commit, checkout, branch, rebase); a repo's git dir lives outside /work and the watcher
// ignores `.git`, so no workspace path can say this. Diff, not snapshot: an absent repo didn't move, it didn't vanish.
export const RefsChangedSchema = z.object({ kind: z.literal("refsChanged"), repos: z.array(z.string()) });
export type RefsChanged = z.infer<typeof RefsChangedSchema>;

// Which running-thing domain just moved (a session, a port, a browser, a subagent); none of it lives on disk, so
// `workspaceChanged` can't name it. Carries only the domain, never the roster, so an uninvolved tab pays no request.
export const RuntimeChangedSchema = z.object({ kind: z.literal("runtimeChanged"), domains: z.array(z.string()) });
export type RuntimeChanged = z.infer<typeof RuntimeChangedSchema>;

// One connected browser tab of a sandbox member; identity from the verified Google ID token, activity from the tab's
// own /system/presence reports. No timestamps: an entry lives exactly as long as its /events connection.
export const PresenceUserSchema = z.object({
    // Per-connection id, minted by the browser for each /events attempt, never reused across reconnects.
    clientId: z.string(),
    email: z.string(),
    name: z.string().optional(),
    picture: z.string().optional(),
    // The caller's trust tier, resolved at connection time; on the roster so a tab can also read its own role.
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

// The full roster of connected members, broadcast on every change; snapshot not diff, so a reconnecting browser is
// consistent from its first frame.
export const PresenceSchema = z.object({ kind: z.literal("presence"), users: z.array(PresenceUserSchema) });
export type Presence = z.infer<typeof PresenceSchema>;

// The full fleet roster, snapshot per change; unlike presence, not last-frame-wins: the browser applies a frame only if
// `rev` is newer, since GET /agents and optimistic writes can race it out of order.
export const AgentsSchema = z.object({ kind: z.literal("agents"), agents: z.array(AgentSummarySchema), rev: z.number() });
export type Agents = z.infer<typeof AgentsSchema>;

// An account's headroom just moved, keyed as the daemon's store keys it. Snapshot per account, last frame wins; `usage`
// absent means the account was disconnected.
export const AccountUsageChangedSchema = z.object({
    kind: z.literal("accountUsage"),
    // The provider whose row this account is; the key alone doesn't say it (a native id is bare).
    provider: z.string(),
    account: z.string(),
    usage: AccountUsageSchema.optional(),
});
export type AccountUsageChanged = z.infer<typeof AccountUsageChangedSchema>;

// A provider's last refusal was recorded or settled, the observed half of "can I run on this". `refusal` absent means
// settled, nothing stands.
export const ProviderRefusalChangedSchema = z.object({ kind: z.literal("providerRefusal"), provider: z.string(), refusal: ProviderRefusalSchema.optional() });
export type ProviderRefusalChanged = z.infer<typeof ProviderRefusalChangedSchema>;

// The /events stream union: hello, heartbeats, boot progress, workspace/repo/ref/runtime changes, presence and fleet
// rosters, account headroom and refusal changes. oRPC validates every frame against this.
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
