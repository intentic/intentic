import {
    AgentHarnessSchema,
    AgentOriginSchema,
    AgentProviderSchema,
    ForkedFromSchema,
    LandConflictSchema,
    LandedMessageSchema,
    LimitPolicySchema,
    profileOf,
    RetryPolicySchema,
    SessionOwnerSchema,
    type TurnProfile,
    TurnProofSchema,
    UnfinishedWorkSchema,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { errorMessage } from "@intentic/base/errors";
import type { ConversationsDb } from "../../store/conversations-db.js";
import { convertDocument } from "../../store/evolution/conversions.js";
import { defineDocument } from "../../store/evolution/documents.js";
import { carryUnknown } from "../../store/evolution/passthrough.js";
import { type ManifestProblem, recordManifestProblems } from "../../store/manifest-problems.js";
import { TurnQueueSchema } from "../actor/conversation-queue.js";

// The persisted half of the fleet registry: one record per conversation, what must survive a restart, as nested records
// whose invariants are their types. Runtime-only state (status, attention, activity) lives in the conversation's actor,
// rebuilt from turn frames. Stored as the `conversation` row, its checkout's repos as `conversation_repo` rows.

// Authority ladder over the title: `derived` (prompt cut to a line), `model` (naming helper wrote it), `plan` (the
// agent's own heading), `user` (a rename, outranks all).
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
        // Held for a press, booked to fire at the reset, and where a booked move takes it: this process's memory, which
        // the registry clears on load.
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

// What the last land left: the commit message drafted the moment it landed (a claim on the main tree, retired only by a
// commit), why it refused (evidence standing.ts reads, never state), and the base-to-tip diffstat across the composition.
const LandingSchema = z.object({
    message: LandedMessageSchema.optional(),
    conflicts: z.array(LandConflictSchema).optional(),
    diff: z.object({ files: z.number(), insertions: z.number(), deletions: z.number() }).optional(),
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
});
export type PersistedAgent = z.infer<typeof PersistedAgentSchema>;

// The `record` column of a `conversation` row, read back with its id and its checkout's repo rows grafted on: a stored
// document like any file, so its shape is frozen and a change to it ships with its conversion here. Not a file the boot
// step can find (a column of conversations.db), so it converts on every read.
export const conversationRecordDocument = defineDocument({
    root: "history",
    path: "conversations.db#conversation.record",
    boot: false,
    schema: PersistedAgentSchema,
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
export type EndingStatus = "idle" | "interrupted" | "stopped" | "error";
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

// One row as this build reads it: the stored record through the document's conversions, and what the schema made of it,
// or why it could not be read.
type RowRead = { readonly ok: true; readonly raw: Record<string, unknown>; readonly entry: PersistedAgent } | { readonly ok: false; readonly detail: string };

const readRow = (id: string, record: string, repos: readonly RepoRecord[]): RowRead => {
    let raw: Record<string, unknown>;
    try {
        const stored = convertDocument(conversationRecordDocument.history, "object", JSON.parse(record)).value;
        if (typeof stored !== "object" || stored === null || Array.isArray(stored)) {
            return { ok: false, detail: "its record is not an object" };
        }
        raw = stored as Record<string, unknown>;
    } catch (error) {
        return { ok: false, detail: `its record could not be converted to this build's shape (${errorMessage(error)})` };
    }
    const placement = raw["placement"] as { readonly kind?: unknown } | undefined;
    const parsed = PersistedAgentSchema.safeParse({ ...raw, id, placement: placement?.kind === "worktree" ? { ...placement, repos } : placement });
    return parsed.success ? { ok: true, raw, entry: parsed.data } : { ok: false, detail: `its record does not match what this build expects (${parsed.error.issues[0]?.path.join(".") ?? ""})` };
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
    const selectRecord = db.prepare("SELECT record FROM conversation WHERE id = ?");
    // The row a save replaces, as its record: what this build's parse dropped from it (a newer build's keys) is carried
    // into the new one. A row this build cannot read at all has nothing it could carry, and is replaced as before.
    const recordFor = (entry: PersistedAgent): string => {
        const updated = recordOf(entry);
        const stored = selectRecord.get(entry.id) as { record: string } | undefined;
        const before = stored === undefined ? undefined : readRow(entry.id, stored.record, reposOf(entry));
        return JSON.stringify(before?.ok === true ? carryUnknown(before.raw, recordOf(before.entry), updated) : updated);
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
                    problems.push({ kind: "invalidEntry", detail: `conversation ${id}: ${read.detail}; it is kept as written` });
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
    };
};
