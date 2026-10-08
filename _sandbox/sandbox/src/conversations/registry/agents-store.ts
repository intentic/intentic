import {
    AgentHarnessSchema,
    AgentOriginSchema,
    AgentProviderSchema,
    type AgentStatus,
    ForkedFromSchema,
    LandConflictSchema,
    LandedMessageSchema,
    LandingDeliverySchema,
    LimitPolicySchema,
    profileOf,
    RetryPolicySchema,
    SessionOwnerSchema,
    type TurnProfile,
    TurnProofSchema,
    TurnReachSchema,
    UnfinishedWorkSchema,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import type { ConversationsDb } from "../../store/conversations-db.js";
import { readDocument } from "@intentic/sandbox-contract/documents";
import { at, CHECK_SETTLES, type JsonObject, mapValue, transform } from "../../store/evolution/conversions.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { type ManifestProblem, recordManifestProblems } from "../../store/manifest/manifest-problems.js";
import { TurnQueueSchema } from "../actor/conversation-queue.js";
import { StoredLimitHoldSchema } from "../actor/limit-hold.js";
import { opt } from "../../opt.js";

// The persisted half of the fleet registry: one record per conversation, what must survive a restart, as nested records
// whose invariants are their types. Runtime-only state (status, attention, activity) lives in the conversation's actor,
// rebuilt from turn frames. Stored as the `conversation` row, its checkout's repos as `conversation_repo` rows.

// Authority ladder over the title: `derived` (prompt cut to a line), `model` (a model chose it: the naming helper, or
// the parent agent that described the child it spawned), `plan` (the agent's own heading), `user` (a rename, outranks
// all).
const AgentTitleSourceSchema = z.enum(["derived", "model", "plan", "user"]);
export type AgentTitleSource = z.infer<typeof AgentTitleSourceSchema>;

// One repo of a worktree conversation's checkout: `base` is the main-line sha the branch stands on, moved by the pre-turn
// rebase; `landedTip`/`landedHead`/`landedAt` are the last land's provenance; `absorbed` marks it fully committed.
const RepoRecordSchema = z.object({
    repo: z.string(),
    base: z.string(),
    landedTip: z.string().optional(),
    landedHead: z.string().optional(),
    landedAt: z.number().optional(),
    absorbed: z.number().optional(),
});
export type RepoRecord = z.infer<typeof RepoRecordSchema>;

// Nested repos a conversation's checkout holds (root is always included, never listed) plus the persona card it was
// read off, so the preamble can name it. Daemon-local; nothing outside this process reads it.
export const CompositionSchema = z.object({
    persona: z.string().optional(),
    repos: z.array(z.string()),
});
export type Composition = z.infer<typeof CompositionSchema>;

// Where the conversation works, latched at its first turn so a stale request can never move it: the shared tree, or a
// checkout of its own on `branch` (on another machine when `runner` names one), carrying `repos` as `composition` says.
const WorktreePlacementSchema = z.object({
    kind: z.literal("worktree"),
    branch: z.string(),
    runner: z.string().optional(),
    repos: z.array(RepoRecordSchema),
    // What the checkout should carry, copied from the opening turn's persona card; absent means everything. A later
    // persona edit never moves an existing conversation.
    composition: CompositionSchema.optional(),
    // The conversation whose checkout the branch was cut from and is rebased onto: a spawned child branched from its
    // parent's work (land-target.ts), whose `base` rows then name commits of the parent's, not of the main line. Absent
    // for every conversation of its own, which stands on the main line.
    parent: z.string().optional(),
    // Whose checkout took the last land instead of the main tree: its parent's. The repos' landed provenance then names
    // that checkout, and nothing that reads main-tree landings (origins, presence, the version commit) counts it.
    landedInto: z.string().optional(),
});
export type WorktreePlacement = z.infer<typeof WorktreePlacementSchema>;
const PlacementSchema = z.discriminatedUnion("kind", [z.object({ kind: z.literal("main") }), WorktreePlacementSchema]);
export type Placement = z.infer<typeof PlacementSchema>;

// Latched on the first turn and never re-read: where it came from (`origin` an automation, `startedBy` who asked, as the
// daemon verified them), the fence it was born with as area ids (absent: the whole workspace), where it opened and as
// whom, and the conversation it was forked from.
const IdentitySchema = z.object({
    origin: AgentOriginSchema.optional(),
    startedBy: z.string().optional(),
    areas: z.array(z.string()).optional(),
    startIn: z.string().optional(),
    actsAs: z.string().optional(),
    forkedFrom: ForkedFromSchema.optional(),
});
export type Identity = z.infer<typeof IdentitySchema>;

// The turn settings the last turn ran under, each kept from the turn before when a turn names none; persisted since a
// client on another device has nowhere else to learn them.
const ProfileSchema = z.object({
    provider: AgentProviderSchema,
    harness: AgentHarnessSchema,
    model: z.string().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
    fast: z.boolean().optional(),
    account: z.string().optional(),
    // The persona the last turn ran as: the turn's own, never carried from the one before, since the daemon runs each turn
    // under the persona it names (turn-premise.ts). Absent for an ordinary chat, and in rows written before it existed.
    actsAs: z.string().optional(),
});
export type StoredProfile = z.infer<typeof ProfileSchema>;

// How the last turn ended, not a live state (rebuilt from frames) or a land verdict (git answers that live).
// `interrupted` is what a daemon killed mid-turn leaves. A spent allowance is its own kind, the only one with limit facts.
const EndingSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("idle") }),
    z.object({ kind: z.literal("interrupted") }),
    z.object({ kind: z.literal("stopped") }),
    z.object({ kind: z.literal("failed"), failure: z.string().optional(), code: z.string().optional() }),
    z.object({
        kind: z.literal("limited"),
        failure: z.string().optional(),
        // Epoch seconds the allowance reopens; absent when the provider publishes no instant.
        resetsAt: z.number().optional(),
        // Held for a press, booked to fire at the reset, and where a booked move takes it: the registry clears them on load
        // unless the entry kept the held turn itself (`limitHold`), which the boot puts back on its actor.
        held: z.boolean(),
        scheduled: z.boolean(),
        moving: z.string().optional(),
    }),
]);
export type Ending = z.infer<typeof EndingSchema>;
export type FailedEnding = Extract<Ending, { kind: "failed" | "limited" }>;

// The conversation's own answer to each sandbox-wide default, absent inheriting it: whether its work lands on its own,
// and each ending's one question (turn-break.ts), armed for a resume with nobody watching.
const PosturesSchema = z.object({
    autoLand: z.boolean().optional(),
    limit: LimitPolicySchema.optional(),
    outage: RetryPolicySchema.optional(),
    stopped: RetryPolicySchema.optional(),
});
export type Postures = z.infer<typeof PosturesSchema>;

// Who took landed work back out of the main tree, as the presence probe read it (landed-presence.ts): the agent working
// there, or the person who threw the changes away.
export const RemoverSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("agent"), id: z.string() }),
    z.object({ kind: z.literal("person"), email: z.string().optional(), name: z.string().optional() }),
]);
export type Remover = z.infer<typeof RemoverSchema>;

// What the last land left: the commit message drafted the moment it landed (a claim on the main tree, retired only by a
// commit), why it refused (evidence standing.ts reads, never state), and the base-to-tip diffstat across the composition.
// `failure` is a land that broke rather than refused, standing until one goes through, or, marked `check`, the
// end-of-turn check that measures held work, standing until a later check reads it; `removedBy` who took the landed
// work back out, while some of it is still missing; `delivery` what the last land did in the owner's folder, for a
// project attached to this computer's sandbox (land/project-delivery.ts), cleared by the next land.
const LandingSchema = z.object({
    message: LandedMessageSchema.optional(),
    conflicts: z.array(LandConflictSchema).optional(),
    diff: z.object({ files: z.number(), insertions: z.number(), deletions: z.number() }).optional(),
    failure: z.object({ reason: z.string(), code: z.string().optional(), at: z.number(), check: z.boolean().optional() }).optional(),
    removedBy: RemoverSchema.optional(),
    delivery: LandingDeliverySchema.optional(),
});
export type Landing = z.infer<typeof LandingSchema>;

// What people left on it rather than anything it did: its name (with the source that ranks it, and the naming pass's one
// work word, never displayed), who answers for it, a standing ask to land, every mark in press order, and when it was
// last opened, the unread badge's reference point, kept here so it holds across devices.
const SocialSchema = z.object({
    title: z.object({ text: z.string(), source: AgentTitleSourceSchema, action: z.string().optional() }).optional(),
    owner: SessionOwnerSchema.optional(),
    landRequested: z.object({ email: z.string(), name: z.string().optional(), at: z.number() }).optional(),
    reactions: z.array(z.object({ emoji: z.string(), email: z.string(), name: z.string().optional(), at: z.number() })),
    seenAt: z.number().optional(),
    // Since when a browser's composer has held unsent words for it (the words stay there); keeps the idle sweep off it.
    unsentAt: z.number().optional(),
});
export type Social = z.infer<typeof SocialSchema>;

// Lifetime spend and counts: completed turns, tool calls, and agents started, counted here rather than off the live
// subagent registry, which forgets a child minutes after it settles and everything across a restart.
const TotalsSchema = z.object({
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    turns: z.number(),
    toolUses: z.number(),
    subagents: z.number(),
});
export type Totals = z.infer<typeof TotalsSchema>;

export const PersistedAgentSchema = z.object({
    // The conversation id.
    id: z.string(),
    placement: PlacementSchema,
    identity: IdentitySchema,
    profile: ProfileSchema,
    sessionId: z.string().optional(),
    // Turn index the context window was last compacted under; the next turn after it restates its preamble notes.
    compactedTurn: z.number().optional(),
    ending: EndingSchema,
    // What the last turn left open, written by the finish that measured it, never cleared for silence.
    unfinished: UnfinishedWorkSchema.optional(),
    // What the last turn that touched code showed of its work, read off its tool calls; a turn that touched none leaves
    // it standing, since the work on the branch has not moved.
    proof: TurnProofSchema.optional(),
    // Where the last turn's work went besides its branch (live files, clones of its own, pushes); replaced by every
    // turn that runs, absent when it all stayed on the branch.
    reach: TurnReachSchema.optional(),
    postures: PosturesSchema,
    landing: LandingSchema,
    social: SocialSchema,
    totals: TotalsSchema,
    createdAt: z.number(),
    updatedAt: z.number(),
    // When archived: off the board, checkout retired, branch kept. The record itself survives untouched.
    archivedAt: z.number().optional(),
    // What waits for its next turn, as its actor last wrote it (conversation-queue.ts); a restart keeps every word of it.
    queue: TurnQueueSchema.optional(),
    // The turn a spent allowance holds, unfired, as its actor last wrote it (actor/limit-hold.ts): what lets a booked
    // resend or move outlive a restart. Read back only while `ending` is still that spent allowance.
    limitHold: StoredLimitHoldSchema.optional(),
});
export type PersistedAgent = z.infer<typeof PersistedAgentSchema>;

// A queue as records before per-message bookings kept a scheduled one: the booking on the queue, none on its messages.
type LegacyBookedQueue = JsonObject & {
    readonly paused: "scheduled";
    readonly until?: number;
    readonly after?: JsonObject;
    readonly items: readonly JsonObject[];
};

// The `record` column of a `conversation` row, read back with its id and its checkout's repo rows grafted on: a stored
// document like any file, so its shape is frozen and a change to it ships with its conversion here. Not a file the boot
// step can find (a column of conversations.db), so it converts on every read.
export const conversationRecordDocument = defineDocument({
    root: "history",
    path: "conversations.db#conversation.record",
    boot: false,
    schema: PersistedAgentSchema,
    history: [
        // The pre-push fix's model role, retired with the push checks on 2026-09-28: a turn queued on it runs on the
        // nearest role that remains, the pipeline fix, which likewise starts only when somebody presses for it.
        at("queue.items.*.turn", mapValue("runRole", { "pre-push-fix": "pipeline-fix" })),
        // 2026-10-06: a queue held one booking for every message in it (`paused: "scheduled"` with the queue's `until` or
        // `after`), so booking a second message re-timed the first. Each message now carries its own; a queue booked as
        // a whole gives that one booking to every message it held, which is when each of them was to go. The queue-level
        // fields stay, as the soonest booking an older build still reads.
        at(
            "queue",
            transform(
                "gives every message of a queue booked as a whole that booking as its own",
                (queue: JsonObject): queue is LegacyBookedQueue =>
                    queue["paused"] === "scheduled" &&
                    (Object.hasOwn(queue, "until") || Object.hasOwn(queue, "after")) &&
                    Array.isArray(queue["items"]) &&
                    !queue["items"].some((item) => item instanceof Object && (Object.hasOwn(item, "until") || Object.hasOwn(item, "after"))),
                (queue: LegacyBookedQueue) => ({
                    ...queue,
                    items: queue.items.map((item) => ({ ...item, ...opt("until", queue.until), ...opt("after", queue.after) })),
                }),
            ),
        ),
    ],
});

// A conversation that owns a worktree, as a type rather than a runtime re-check.
export type IsolatedAgent = PersistedAgent & { readonly placement: WorktreePlacement };
export const isIsolated = (entry: PersistedAgent): entry is IsolatedAgent => entry.placement.kind === "worktree";

// The worktree a conversation owns, undefined for one working in the shared tree (or none at all).
export const worktreeOf = (entry: PersistedAgent | undefined): WorktreePlacement | undefined =>
    entry?.placement.kind === "worktree" ? entry.placement : undefined;

// The checkout's repos, none for a conversation working in the shared tree.
export const reposOf = (entry: PersistedAgent): readonly RepoRecord[] => worktreeOf(entry)?.repos ?? [];

// The ending in the card's status vocabulary: both failure kinds read as `error`.
export type EndingStatus = Extract<AgentStatus, "idle" | "interrupted" | "stopped" | "error">;
export const endingStatus = (ending: Ending): EndingStatus =>
    ending.kind === "failed" || ending.kind === "limited" ? "error" : ending.kind;

// Whether a compaction happened since the last turn, so its preamble note must repeat. `>=`, not `===`: the read is one
// turn behind the write, so a turn whose count did not advance errs toward telling twice.
export const compactedSinceLastTurn = (entry: { readonly compactedTurn?: number | undefined } | undefined, conversationTurns: number): boolean =>
    entry?.compactedTurn !== undefined && entry.compactedTurn >= conversationTurns - 1;

// What the conversation runs as now, as its last turn left it: the profile a turn the daemon starts on it (a wake, a
// child's report, a peer's message) carries. Only the fields the entry keeps; placement and job are the turn's own.
export const conversationProfile = (entry: PersistedAgent): TurnProfile =>
    profileOf({
        agent: entry.profile.provider,
        harness: entry.profile.harness,
        model: entry.profile.model,
        effort: entry.profile.effort,
        thinking: entry.profile.thinking,
        fast: entry.profile.fast,
        account: entry.profile.account,
        actsAs: entry.identity.actsAs,
    });

export interface AgentsStore {
    // Every conversation whose record this build can read; one it cannot costs that one, never the roster.
    readonly load: () => PersistedAgent[];
    // Each record whole, its repo rows replaced with it; one transaction, joining the caller's when one is open.
    readonly save: (entries: readonly PersistedAgent[]) => void;
    // Each conversation's row and, by cascade, every row keyed by it in any table; one transaction.
    readonly remove: (ids: readonly string[]) => void;
    // Whether a row exists for the conversation, readable by this build or not.
    readonly has: (id: string) => boolean;
    // Whether any conversation has a row, readable by this build or not.
    readonly any: () => boolean;
}

interface RepoRow {
    readonly conversation_id: string;
    readonly repo: string;
    readonly base: string;
    readonly landed_tip: string | null;
    readonly landed_head: string | null;
    readonly landed_at: number | null;
    readonly absorbed: number | null;
}

const fromRow = (row: RepoRow): RepoRecord => ({
    repo: row.repo,
    base: row.base,
    ...(row.landed_tip === null ? {} : { landedTip: row.landed_tip }),
    ...(row.landed_head === null ? {} : { landedHead: row.landed_head }),
    ...(row.landed_at === null ? {} : { landedAt: row.landed_at }),
    ...(row.absorbed === null ? {} : { absorbed: row.absorbed }),
});

// The record column: the entry less its key and its repos, which are rows of their own.
const recordOf = ({ id: _key, placement, ...rest }: PersistedAgent): Record<string, unknown> => {
    if (placement.kind === "main") {
        return { ...rest, placement };
    }
    const { repos: _rows, ...checkout } = placement;
    return { ...rest, placement: checkout };
};

// One row as this build reads it, through the one document read (readDocument): the stored record through the
// document's conversions, its id and repo rows grafted on before the schema, or why it could not be read.
type RowRead =
    | { readonly ok: true; readonly entry: PersistedAgent; readonly carry: (updated: PersistedAgent) => unknown }
    | { readonly ok: false; readonly reason: ManifestProblem["reason"]; readonly detail: string };

const readRow = (id: string, record: string, repos: readonly RepoRecord[]): RowRead => {
    // The first path the schema refused, which a reader of the report needs more than the sentence around it.
    let refused = "";
    const read = readDocument<PersistedAgent>(
        record,
        conversationRecordDocument,
        {
            kind: "whole",
            parse: (raw) => {
                const stored = raw as { readonly placement?: { readonly kind?: unknown } } | null;
                const placement = stored?.placement?.kind === "worktree" ? { ...stored.placement, repos } : stored?.placement;
                const parsed = PersistedAgentSchema.safeParse({ ...(raw as object), id, placement });
                refused = parsed.success ? "" : (parsed.error.issues[0]?.path.join(".") ?? "");
                return parsed.data;
            },
        },
        CHECK_SETTLES,
    );
    if (read.value === undefined) {
        const [problem] = read.problems;
        // Said of the row, not of a file: the detail readDocument gives is about a file's bytes.
        const said =
            problem?.reason === "rejected"
                ? "its record does not match what this build expects"
                : problem?.reason === "not-json"
                  ? "its record is not valid JSON"
                  : (problem?.detail ?? "its record could not be read");
        return { ok: false, reason: problem?.reason, detail: `${said}${refused === "" ? "" : ` (${refused})`}` };
    }
    return { ok: true, entry: read.value, carry: read.carry };
};

export const sqliteAgentsStore = ({ db, path, transaction }: ConversationsDb): AgentsStore => {
    const upsert = db.prepare("INSERT INTO conversation(id, record) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record = excluded.record");
    const dropRepos = db.prepare("DELETE FROM conversation_repo WHERE conversation_id = ?");
    const insertRepo = db.prepare(
        "INSERT INTO conversation_repo(conversation_id, position, repo, base, landed_tip, landed_head, landed_at, absorbed) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const deleteConversation = db.prepare("DELETE FROM conversation WHERE id = ?");
    const selectConversations = db.prepare("SELECT id, record FROM conversation");
    const selectRepos = db.prepare("SELECT * FROM conversation_repo ORDER BY conversation_id, position");
    const selectOne = db.prepare("SELECT 1 FROM conversation WHERE id = ?");
    const selectAny = db.prepare("SELECT 1 FROM conversation LIMIT 1");
    const selectRecord = db.prepare("SELECT record FROM conversation WHERE id = ?");
    // The row a save replaces, as its record: what this build's parse dropped from it (a newer build's keys) is carried
    // into the new one. A row this build cannot read at all has nothing it could carry, and is replaced as before.
    const recordFor = (entry: PersistedAgent): string => {
        const updated = recordOf(entry);
        const stored = selectRecord.get(entry.id) as { record: string } | undefined;
        const before = stored === undefined ? undefined : readRow(entry.id, stored.record, reposOf(entry));
        return JSON.stringify(before?.ok === true ? recordOf(before.carry(entry) as PersistedAgent) : updated);
    };
    return {
        load: () => {
            const repos = new Map<string, RepoRecord[]>();
            for (const row of selectRepos.all() as unknown as RepoRow[]) {
                const held = repos.get(row.conversation_id);
                if (held === undefined) {
                    repos.set(row.conversation_id, [fromRow(row)]);
                } else {
                    held.push(fromRow(row));
                }
            }
            // A row this build cannot read costs that conversation, never the roster, and is reported, not dropped in
            // silence: it stays in the database as written, where the build that wrote it reads it again.
            const problems: ManifestProblem[] = [];
            const loaded = (selectConversations.all() as unknown as { id: string; record: string }[]).flatMap(({ id, record }) => {
                const read = readRow(id, record, repos.get(id) ?? []);
                if (!read.ok) {
                    problems.push({ kind: "invalidEntry", ...(read.reason === undefined ? {} : { reason: read.reason }), detail: `conversation ${id}: ${read.detail}; it is kept as written` });
                    return [];
                }
                return [read.entry];
            });
            recordManifestProblems(path, problems);
            return loaded;
        },
        save: (entries) =>
            transaction(() => {
                for (const entry of entries) {
                    upsert.run(entry.id, recordFor(entry));
                    dropRepos.run(entry.id);
                    reposOf(entry).forEach((repo, position) =>
                        insertRepo.run(
                            entry.id,
                            position,
                            repo.repo,
                            repo.base,
                            repo.landedTip ?? null,
                            repo.landedHead ?? null,
                            repo.landedAt ?? null,
                            repo.absorbed ?? null,
                        ),
                    );
                }
            }),
        remove: (ids) =>
            transaction(() => {
                for (const id of ids) {
                    deleteConversation.run(id);
                }
            }),
        has: (id) => selectOne.get(id) !== undefined,
        any: () => selectAny.get() !== undefined,
    };
};
