import { z } from "zod";
import { AgentSummarySchema } from "../schemas/agents.js";
import { AccountUsageSchema, type ProviderRefusal, ProviderRefusalSchema } from "../schemas/providers/plan-limits.js";
import { MemberRoleSchema } from "../schemas/shared.js";
import { WorkspaceTreeDeltaSchema } from "../schemas/workspace/workspace-tree.js";

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

// The hello's fields, named rather than inferred (agent-press.ts says the same of its press): spelled out inside the
// `/events` route the frame took the aggregated contract's type past what the declaration emitter will write (TS7056).
// A field added below is added here too, which the assignment checks.
type OptionalStrings = z.ZodOptional<z.ZodArray<z.ZodString>>;
type OptionalStringMap = z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodString>>;
// A type rather than an interface: z.object needs the index signature only an object type literal is given.
export type HelloFields = {
    readonly kind: z.ZodLiteral<"hello">;
    readonly workspaceId: z.ZodString;
    readonly routes: OptionalStrings;
    readonly shapes: OptionalStringMap;
    readonly rawRoutes: OptionalStrings;
    readonly rawFingerprints: OptionalStringMap;
    readonly prints: z.ZodOptional<z.ZodRecord<z.ZodString, z.ZodTuple<[z.ZodString, z.ZodString], null>>>;
    readonly uploadEncodings: OptionalStrings;
    readonly voiceCodecs: OptionalStrings;
    readonly build: z.ZodOptional<z.ZodString>;
    readonly boot: z.ZodOptional<typeof BootProgressSchema>;
    readonly projectDir: z.ZodOptional<z.ZodString>;
    readonly surface: z.ZodOptional<z.ZodEnum<{ sandbox: "sandbox"; folder: "folder" }>>;
    readonly recordsSwitches: z.ZodOptional<z.ZodBoolean>;
};

// The stream's first frame: `workspaceId` and `build` key the browser's persisted cache, so a wiped workspace or new
// image doesn't hydrate stale data. `routes`/`shapes` turn a version-skewed 404 or missing field into a named gap.
export const HelloSchema: z.ZodObject<HelloFields, z.core.$strip> = z.object({
    kind: z.literal("hello"),
    workspaceId: z.string(),
    routes: z.array(z.string()).optional(),
    shapes: z.record(z.string(), z.string()).optional(),
    // The same two for the hand-written routes (`POST /workspace/upload-diff`), which are half the daemon's surface and
    // used to be advertised nowhere: a call onto a raw route an older daemon predates could only come back as a bare
    // 404. Their own fields rather than more entries in `routes`, which an older browser reads as proof that it is
    // itself the stale side. Absent means a daemon from before this field, and no evidence either way.
    // `rawFingerprints` is what `shapes` is for a procedure, under the name the rest of the code gives it.
    rawRoutes: z.array(z.string()).optional(),
    rawFingerprints: z.record(z.string(), z.string()).optional(),
    // Every route's second print, procedures and hand-written routes in one map: `[wire, core]` (protocol/routes.ts
    // `RoutePrints`). `wire` is the shape without its prose, `core` only what has to hold for a call to work, so a page
    // ahead of the sandbox can tell a part that arrives with the next update from one that may misbehave. Absent means
    // a daemon from before the field, which the browser compares on `shapes` and `rawFingerprints` as it always did.
    prints: z.record(z.string(), z.tuple([z.string(), z.string()])).optional(),
    // The codings `POST /workspace/upload` and `POST /workspace/upload-archive` decode a request body from
    // (`Content-Encoding`). Absent means a daemon that writes whatever bytes arrive, so the browser sends them plain.
    uploadEncodings: z.array(z.string()).optional(),
    // The codings the voice sockets speak besides PCM when asked (`codec=opus`, schemas/voice.ts). Absent or empty: PCM
    // only, which is every daemon from before the field and one whose Opus binding did not load.
    voiceCodecs: z.array(z.string()).optional(),
    // `<version>:<newest mtime of the compiled tree>`, as every release since 1.0.0 sends it. The version at its head
    // is what the browser holds against the oldest daemon it supports (state/daemon-floor.ts), so it stays first.
    build: z.string().optional(),
    boot: BootProgressSchema.optional(),
    // A project sandbox's folder, workspace-relative (`my-app` for /work/my-app): the owner's own folder, synced live
    // with their computer, which the browser scopes the workspace to on arrival. Absent on every other sandbox.
    projectDir: z.string().optional(),
    // What answers: a sandbox's daemon, or the desktop app's sidecar serving a folder on the user's own computer
    // (_devices/local-files), whose `routes` are the few a folder has rather than a daemon's missing ones. Absent reads
    // as a sandbox, which every daemon before this field was.
    surface: z.enum(["sandbox", "folder"]).optional(),
    // True when this daemon writes a `switched` notice (schemas/providers/switched.ts) on every turn that goes out on
    // another provider, account, loop or model than the turn before it, so the conversation's record says so for every
    // window. Absent is a daemon from before the field, whose editor must keep drawing the divider itself.
    recordsSwitches: z.boolean().optional(),
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

// Files whose rendered text just landed. Renderings live under the state directory the watcher ignores on purpose — a
// cache write must never read as a workspace change — so `workspaceChanged` structurally cannot carry this, and without
// it a second reader watching the same file never sees its text land.
export const DerivedChangedSchema = z.object({ kind: z.literal("derivedChanged"), paths: z.array(z.string()) });
export type DerivedChanged = z.infer<typeof DerivedChangedSchema>;

// Files that changed in one conversation's own copy, workspace-relative forward-slash, from the watch a reader holds on
// their folders (workspace.followCheckout). A checkout lives outside /work, so no `workspaceChanged` batch can carry
// these; never an empty "refetch everything" batch, since the watch names what it saw or says nothing.
export const CheckoutChangedSchema = z.object({ kind: z.literal("checkoutChanged"), agent: z.string(), paths: z.array(z.string()) });
export type CheckoutChanged = z.infer<typeof CheckoutChangedSchema>;

// Repos whose refs moved (commit, checkout, branch, rebase); a repo's git dir lives outside /work and the watcher
// ignores `.git`, so no workspace path can say this. Diff, not snapshot: an absent repo didn't move, it didn't vanish.
// `conversations` is present only when every ref that moved was some conversation's own (its branch `agent/<id>`, the
// shelf an archive parks it on, the pins its carry and drop leave, a runner's delivery of its turn): those
// conversations, whose reviews (and their children's) are all such a move can change. Absent when anything else moved
// (the main line, a named branch, a tag, a fetch) or the daemon cannot say, which reaches every review.
export const RefsChangedSchema = z.object({
    kind: z.literal("refsChanged"),
    repos: z.array(z.string()),
    conversations: z.array(z.string()).optional(),
});
export type RefsChanged = z.infer<typeof RefsChangedSchema>;

// Which running-thing domain just moved (a session, a port, a browser, a subagent); none of it lives on disk, so
// `workspaceChanged` can't name it. Carries only the domain, never the roster, so an uninvolved tab pays no request.
// `draftsGeneration`, beside a `drafts` domain: how many times the reader's own drafts and marks had moved in this
// daemon's run as the frame went out (a write or a clear answers with the count it made), so a window that made every
// one of those moves itself holds them already and has nothing to read back.
export const RuntimeChangedSchema = z.object({
    kind: z.literal("runtimeChanged"),
    domains: z.array(z.string()),
    draftsGeneration: z.number().int().nonnegative().optional(),
});
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
    // On screen, but untouched for several minutes (PresenceReport's `away`); absent reads as not away.
    away: z.boolean().optional(),
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

// Only the cards running turns moved since this connection's previous roster frame (`since`, that frame's `rev`): what a
// connection that asked for changes (`roster: "changes"` on /events) gets in place of the whole roster on each progress
// tick, since resending every card to every window on every tool call made the roster the daemon's costliest send. Each
// card is whole, an upsert by id; a card leaving the board is never a change, it goes out as an `agents` snapshot. A
// browser holding an older roster than `since` missed a frame and reads GET /agents again. Sent even when the reader may
// see none of the cards, so the revision line it follows has no hole in it.
export const AgentsChangedSchema = z.object({
    kind: z.literal("agentsChanged"),
    agents: z.array(AgentSummarySchema),
    rev: z.number(),
    since: z.number(),
});
export type AgentsChanged = z.infer<typeof AgentsChangedSchema>;

// How a connection takes the roster as running agents make progress (/events `roster`): whole every time (`snapshots`,
// the default), or only the cards that moved (`changes`, as `agentsChanged` frames).
export const RosterFramesSchema = z.enum(["snapshots", "changes"]);
export type RosterFrames = z.infer<typeof RosterFramesSchema>;

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

// A provider's refusals on file changed (one recorded, settled or forgotten), the observed half of "can I run on this":
// every one it still holds, so a window judges by exactly what the daemon does. Empty means nothing stands. A daemon at
// the floor sends only its last `refusal` (absent: settled), so `refusals` stays optional; read both with refusalsOf.
export const ProviderRefusalChangedSchema = z.object({
    kind: z.literal("providerRefusal"),
    provider: z.string(),
    refusals: z.array(ProviderRefusalSchema).optional(),
    refusal: ProviderRefusalSchema.optional(),
});
export type ProviderRefusalChanged = z.infer<typeof ProviderRefusalChangedSchema>;

// Every refusal a frame says stands, from a daemon that sends the whole list or one at the floor that sends its last.
export const refusalsOf = (event: ProviderRefusalChanged): readonly ProviderRefusal[] =>
    event.refusals ?? (event.refusal === undefined ? [] : [event.refusal]);

// What moved in the shared tree, once the daemon's resident copy re-listed a batch: a tab holding the generation it
// counts from patches its tree, and one holding any other fetches it afresh.
export const TreeChangedSchema = WorkspaceTreeDeltaSchema.extend({ kind: z.literal("treeChanged") });
export type TreeChanged = z.infer<typeof TreeChangedSchema>;

// The /events stream union: hello, heartbeats, boot progress, workspace/checkout/repo/ref/runtime/shadow/tree changes,
// presence and fleet rosters (whole, or the cards that moved), account headroom and refusal changes. oRPC validates
// every frame against this.
export const SystemEventSchema = z.discriminatedUnion("kind", [
    HelloSchema,
    HeartbeatSchema,
    BootSchema,
    WorkspaceChangedSchema,
    TreeChangedSchema,
    DerivedChangedSchema,
    CheckoutChangedSchema,
    ReposChangedSchema,
    RefsChangedSchema,
    RuntimeChangedSchema,
    PresenceSchema,
    AgentsSchema,
    AgentsChangedSchema,
    AccountUsageChangedSchema,
    ProviderRefusalChangedSchema,
]);
export type SystemEvent = z.infer<typeof SystemEventSchema>;
