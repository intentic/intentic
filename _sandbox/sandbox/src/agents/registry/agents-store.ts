import { readFile, rename } from "node:fs/promises";
import {
    AgentHarnessSchema,
    AgentOriginSchema,
    AgentProviderSchema,
    ForkedFromSchema,
    LandConflictSchema,
    type LandedMessage,
    UnfinishedWorkSchema,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { writeJsonFile } from "../../store/json-file.js";

// Persisted half of the fleet registry (<historyRoot>/agents.json, on /history so identity survives container
// rebuilds); one entry per conversation. Runtime-only state (status, attention, activity) lives in the registry's
// memory, rebuilt from turn frames; only what must survive a restart is here.

// How the last turn ended, not a live state (running/awaiting, rebuilt live) or a derived land verdict (git answers
// that live). `interrupted` is what a daemon killed mid-turn leaves; only it triggers the boot resume.
const PersistedAgentStatusSchema = z.enum(["idle", "interrupted", "stopped", "error"]).catch("idle");

// Authority ladder over the title: `derived` (prompt cut to a line), `model` (naming helper wrote it), `plan` (the
// agent's own heading), `user` (a rename, outranks all). Unknown values fall back to `derived`.
const AgentTitleSourceSchema = z.enum(["derived", "model", "plan", "user"]).catch("derived");
export type AgentTitleSource = z.infer<typeof AgentTitleSourceSchema>;

// Whether a compaction happened since the last turn, so its preamble note must repeat. `>=`, not `===`: the read is one
// turn behind the write, so a turn whose count did not advance errs toward telling twice.
export const compactedSinceLastTurn = (entry: { readonly compactedTurn?: number | undefined } | undefined, conversationTurns: number): boolean =>
    entry?.compactedTurn !== undefined && entry.compactedTurn >= conversationTurns - 1;

// Nested repos a conversation's checkout holds (root is always included, never listed) plus the persona card it was
// read off, so the preamble can name it. Daemon-local; nothing outside this process reads it.
export const CompositionSchema = z.object({
    persona: z.string().optional(),
    repos: z.array(z.string()),
});
export type Composition = z.infer<typeof CompositionSchema>;

export const PersistedAgentSchema = z.object({
    // `id` is the conversationId; `branch` is present only for an isolated conversation.
    id: z.string(),
    branch: z.string().optional(),
    // The paired runner's id, absent for one that runs here; latched with the identity like `branch`, so a stale tab
    // cannot move it between machines. A remote conversation is isolated by construction.
    runner: z.string().optional(),
    // Display name, one sanitized line; `titleSource` says how it got there and gates the next promotion.
    title: z.string().optional(),
    titleSource: AgentTitleSourceSchema.optional(),
    provider: AgentProviderSchema,
    harness: AgentHarnessSchema,
    // Turn settings last run under; persisted since a client on another device has nowhere else to learn them.
    model: z.string().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
    fast: z.boolean().optional(),
    // What the complexity judge made of the last turn, feeding the next turn's `afterHardTurn` signal; may be read
    // tomorrow, from another device. The judgement itself, never what ran; absent means nothing judged yet.
    tier: z.enum(["fast", "standard"]).optional(),
    // Standing veto over automatic tier selection; mirrored onto AgentSummary, since the composer's own toggle draws
    // it.
    tierHold: z.boolean().optional(),
    account: z.string().optional(),
    sessionId: z.string().optional(),
    // Turn index the context window was last compacted under; absent means never compacted. The next turn after that
    // index has to restate its preamble notes, since compaction summarized away the messages they rode in on.
    compactedTurn: z.number().optional(),
    // Set when an automation (a mention, a webhook) opened this conversation; absent means the user started it.
    origin: AgentOriginSchema.optional(),
    // Who asked for the first turn, latched like `origin`; absent when the request carried no verified identity.
    startedBy: z.string().optional(),
    // Where this conversation was forked from; written once at the fork's first turn and never cleared.
    forkedFrom: ForkedFromSchema.optional(),
    // Per-repo worktree state. `base` is the main-line sha the branch stands on, moved by the pre-turn rebase;
    // `landedTip`/`landedHead`/`landedAt` are the last land's provenance; `absorbed` marks it fully committed.
    repos: z.array(
        z.object({
            repo: z.string(),
            base: z.string(),
            landedTip: z.string().optional(),
            landedHead: z.string().optional(),
            landedAt: z.number().optional(),
            absorbed: z.number().optional(),
        }),
    ),
    // What the checkout should carry, copied from the opening turn's persona card; `repos` above is brought to this
    // each later turn. Absent means everything; a later persona edit never moves an existing conversation.
    composition: CompositionSchema.optional(),
    // What the landed work did, as a commit subject drafted the moment it lands, for the Changes panel's chip. Kept
    // here rather than derived on demand, since deriving it would put model latency behind a click meant to be instant.
    landedSubject: z.string().optional(),
    // User-facing sentence for the same landing (a changelog entry); persisted since the commit often comes long after.
    landedNote: z.string().optional(),
    // Breaking-change sentence for the Release's trailer; almost always absent.
    landedBreaking: z.string().optional(),
    status: PersistedAgentStatusSchema,
    // Why the last turn failed; persisted since the reader who needs it arrives hours later, and a fresh turn clears
    // it.
    failure: z.string().optional(),
    // Which kind of failure, the frame's own code; persisted and cleared alongside `failure`.
    failureCode: z.string().optional(),
    // A refused turn's limit facts: when it reopens, whether held for a press, whether a fire is booked. The latter two
    // are dropped on load; that memory does not survive a restart.
    limitResetsAt: z.number().optional(),
    limitHeld: z.boolean().optional(),
    limitScheduled: z.boolean().optional(),
    // Where a booked move was taking it; stripped on load along with `limitHeld`/`limitScheduled`.
    limitMoving: z.string().optional(),
    // Override of the sandbox-wide autoLand default (absent inherits); must govern turns that finish unattended.
    autoLand: z.boolean().optional(),
    // Same override for outages; the whole point of arming it is a resume with nobody watching.
    resumeAfterOutage: z.boolean().optional(),
    // Same override for limits, more so: the reopening is often hours past the tab that armed it.
    resumeAfterLimit: z.boolean().optional(),
    // Same override for moving accounts on a spent limit.
    moveAfterLimit: z.boolean().optional(),
    // A collaborator's standing ask to land; persisted so it survives a restart.
    landRequested: z.object({ email: z.string(), name: z.string().optional(), at: z.number() }).optional(),
    // Why the last land refused; evidence, not state, standing.ts reads it to explain a delta and never to invent one.
    // A land-time snapshot: surfaces re-derive from it rather than replay its per-path content.
    conflicts: z.array(LandConflictSchema).optional(),
    // What the last turn left open, written by the finish that measured it; persisted for a reader who returns tomorrow
    // to a settled card. Rewritten only when a finish actually observed the checklist, never cleared for silence.
    unfinished: UnfinishedWorkSchema.optional(),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    // Completed turns and lifetime tool calls; optional, since entries older than these counters read as absent.
    turns: z.number().optional(),
    toolUses: z.number().optional(),
    // Agents started, for this conversation's whole life. Counted here rather than off the live subagent registry,
    // which forgets a child minutes after it settles and everything across a restart.
    subagents: z.number().optional(),
    // Cumulative base-to-tip diffstat across the composition, refreshed on each land.
    diffFiles: z.number().optional(),
    diffInsertions: z.number().optional(),
    diffDeletions: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    // When last opened, the unread badge's reference point; kept here, not in a browser, so it holds across devices.
    seenAt: z.number().optional(),
    // When archived: off the board, checkout retired, branch kept. Absent means live; the entry itself survives
    // untouched.
    archivedAt: z.number().optional(),
});
export type PersistedAgent = z.infer<typeof PersistedAgentSchema>;

// A conversation that owns a worktree, as a type rather than a runtime re-check: branch-only code paths take this so
// the compiler carries the guarantee instead of each one re-testing `branch !== undefined`.
export type IsolatedAgent = PersistedAgent & { branch: string };
export const isIsolated = (entry: PersistedAgent): entry is IsolatedAgent => entry.branch !== undefined;

// The drafted commit message as one value, whether read off the live card or the review's own record; stored as three
// flat columns. `undefined` before any sentence is written, and notes never ride without a subject.
export const landedMessageOf = (entry: PersistedAgent): LandedMessage | undefined =>
    entry.landedSubject === undefined
        ? undefined
        : {
              subject: entry.landedSubject,
              ...(entry.landedNote === undefined ? {} : { note: entry.landedNote }),
              ...(entry.landedBreaking === undefined ? {} : { breaking: entry.landedBreaking }),
          };

export interface AgentsStore {
    readonly load: () => Promise<PersistedAgent[]>;
    // Full-replace write; the registry owns the authoritative array after init.
    readonly save: (agents: readonly PersistedAgent[]) => Promise<void>;
}

// The fleet's only record of which conversations exist; a load that answers a bad file with `[]` would have the next
// write-through persist that emptiness forever. Both guard against it:
// - save is atomic (tmp + rename), so a daemon killed mid-write leaves the previous file intact
// - load never lets unreadable content be overwritten: a bad file is set aside, a bad entry dropped alone
export const fileAgentsStore = (path: string): AgentsStore => ({
    load: async () => {
        let raw: string;
        try {
            raw = await readFile(path, "utf8");
        } catch {
            return []; // Absent means a fresh sandbox; the one case where an empty fleet is the truth.
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // Not valid JSON (a torn write, a stray edit). Renamed out of the write path first, since returning `[]`
            // with the bad file still there is how one bad boot used to erase the fleet on the next persist.
            await rename(path, `${path}.corrupt`).catch(() => undefined);
            return [];
        }
        if (!Array.isArray(parsed)) {
            await rename(path, `${path}.corrupt`).catch(() => undefined);
            return [];
        }
        // Per entry, not the whole array: one row a schema no longer accepts costs that row, not the whole roster.
        return parsed.flatMap((entry) => {
            const result = PersistedAgentSchema.safeParse(entry);
            return result.success ? [result.data] : [];
        });
    },
    // Write-then-rename, so the file is always one complete roster or the previous one, never a prefix. Through the
    // shared writer since /history can be shared by a second daemon, whose temp file needs its own pid tag.
    save: (agents) => writeJsonFile(path, agents),
});
