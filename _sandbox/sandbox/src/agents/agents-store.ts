import { readFile, rename } from "node:fs/promises";
import { AgentHarnessSchema, AgentOriginSchema, AgentProviderSchema, LandConflictSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { writeJsonFile } from "../store/json-file.js";

// The persisted half of the fleet registry (<historyRoot>/agents.json — on the /history volume so a
// conversation's identity survives container rebuilds alongside any worktree it owns). One entry per
// conversation. Runtime-only state (running/awaiting, attention, activity, context fill) lives in the
// registry's memory and is rebuilt from turn frames; only what must survive a restart is here.

/* THE TURN LIFECYCLE, and nothing else. Every value here is an EVENT — how the last turn ended — which is
 * exactly the class of fact nothing but this entry remembers. running/awaiting are excluded because they are
 * rebuilt from the live turn's frames (a daemon restart mid-turn must rehydrate to a state the user can act
 * on), and ready/landed/conflict because they are not facts about the turn at all: they answer "does this
 * branch hold work the main line does not", which git answers live and correctly at any moment. Storing that
 * answer made a cache with no invalidation, and a card that outlived what it described — see standing.ts.
 *
 * `interrupted` is what a LIVE turn leaves here — written by registry.begin, overwritten by registry.finish.
 * The value on disk while a turn runs is therefore the one that should stand if the daemon never comes back,
 * which is the only way to get this right: the daemon does not get to write a parting state. Its container is
 * recreated with `docker rm -f` on every rebuild (dev-sandbox.sh) and it is equally free to be OOM-killed, so
 * anything that depended on a graceful shutdown — or on a boot pass repairing a "running" marker — would be
 * skipped in exactly the cases it exists for.
 *
 * Writing `idle` here instead is what filed a killed agent under Finished: `idle` is the resting status of a
 * turn that ended CLEANLY, so an agent whose turn was parked on a question, and whose park died with the
 * process holding it, came back indistinguishable from one that had nothing left to do.
 *
 * `stopped` is the same class of fact for the turn a PERSON ended, and it is separate from `interrupted` for a
 * reason that outlives the label: only `interrupted` is a candidate for the boot resume pass. A turn somebody
 * chose to stop must never come back on its own.
 *
 * `.catch` rather than a bare enum, and the only field here that carries one: agents.json is user data on a
 * volume that outlives every image, so this field's vocabulary shrinking must cost the VALUE, not the row. The
 * per-entry parse below already treats losing a row as a cost to be minimised; a status that no longer exists
 * reads as the resting one, which is what every retired value meant — the turn ended and the land question is
 * now asked of git. */
const PersistedAgentStatusSchema = z.enum(["idle", "interrupted", "stopped", "error"]).catch("idle");

/* Where a title came from, which is the whole of what decides whether a better one may replace it. The ladder
 * is one question asked four times — how much authority does whoever wrote this name have over the job?
 *
 * `derived` is the opening prompt CUT to a line by a rule with no model behind it (deriveTitle), which is the
 * best that can be done before the first frame comes back. `model` is the quick model's name for the same
 * prompt (agent/title-namer.ts): it writes rather than cuts, so it beats the guess. `plan` is the heading of a
 * plan the agent wrote — its own name for the whole job, better than any reading of the ask alone. `user` is a
 * rename, which outranks everything: an agent that renames a tab the user just named is a bug.
 *
 * `.catch`, for the reason PersistedAgentStatusSchema carries one: agents.json is user data on a volume that
 * outlives every image, so a value retired from this vocabulary must cost the FIELD and not the row. Reading a
 * retired source as `derived` says exactly what losing it means — the name that is there stands until anything
 * better arrives, which is the resting state of every title. */
const AgentTitleSourceSchema = z.enum(["derived", "model", "plan", "user"]).catch("derived");
export type AgentTitleSource = z.infer<typeof AgentTitleSourceSchema>;

export const PersistedAgentSchema = z.object({
    // The conversationId. `branch` is the placement discriminator: present for an isolated conversation,
    // absent for one that works directly in the shared workspace.
    id: z.string(),
    branch: z.string().optional(),
    // The display name, sanitized to one bounded line — derived from the opening prompt, promoted to a plan's
    // heading, or chosen outright by a rename. `titleSource` says which, and gates the next promotion.
    title: z.string().optional(),
    titleSource: AgentTitleSourceSchema.optional(),
    provider: AgentProviderSchema,
    harness: AgentHarnessSchema,
    // The turn settings this conversation last ran under — see AgentSummarySchema. Persisted because a client
    // that opens the agent tomorrow, on another device, has nowhere else to learn them from.
    model: z.string().optional(),
    effort: z.string().optional(),
    thinking: z.boolean().optional(),
    fast: z.boolean().optional(),
    account: z.string().optional(),
    sessionId: z.string().optional(),
    // Set when an automation opened this conversation for an outside message (a Discord mention, a web-chat
    // visitor, a webhook) instead of the user starting it. Absent ⇒ a user-started agent.
    origin: AgentOriginSchema.optional(),
    // The worktree composition: each workspace repo ("root" or a repo id — its root-relative dir) with the full
    // sha its worktree sits on the main line at, and the branch tip whose delta has already LANDED into the main
    // tree (absent ⇒ nothing landed yet — the base is the reference). Land applies `landedTip → tip`, so each
    // land carries only the new delta; the review reads `base` and flags each file against `landedTip`.
    //
    // `base` MOVES: the pre-turn rebase advances it whenever the main line has run ahead of the branch
    // (agents/sync.ts), so it is where the branch stands rather than where it started. `landedTip` does not
    // follow it — that sha is the provenance of a land that really happened, and a rewrite that orphans it is
    // exactly the case anchorOf falls through to the merge-base for (agents/agent-changes.ts).
    //
    // `landedHead`/`landedAt` are that land's provenance in the MAIN tree: the commit HEAD stood on and when.
    // They are what lets the Changes panel say which agent an uncommitted file came from — `base → landedTip`
    // names the paths, and a HEAD that has since moved retires the claim (see agents/origins.ts).
    repos: z.array(
        z.object({
            repo: z.string(),
            base: z.string(),
            landedTip: z.string().optional(),
            landedHead: z.string().optional(),
            landedAt: z.number().optional(),
        }),
    ),
    status: PersistedAgentStatusSchema,
    // Why the last turn failed — the EVIDENCE behind an errored card, the same role `conflicts` below plays for
    // a refused land (see AgentSummarySchema). Persisted rather than held in the turn's runtime state because
    // the reader who needs it most arrives hours later, at a card nobody watched fail; a fresh turn rebuilds the
    // entry without it, which is what clears it.
    failure: z.string().optional(),
    // Per-agent override of the sandbox-wide autoLand setting, absent ⇒ inherit — see AgentSummarySchema.
    // Persisted because it must govern turns that finish with no browser attached (automations included).
    autoLand: z.boolean().optional(),
    // Why the last land refused — the EVIDENCE behind a conflicted card, which is a different thing from the
    // card's state: standing.ts reads this only to explain an outstanding delta, never to create one, so a
    // report whose delta has since gone stops being rendered without needing to be rewritten. Written and
    // cleared by the same recordLanded that advances the tips — but its per-path CONTENT is a snapshot of
    // land time (a `workspace` row names uncommitted edits the user clears by committing, which no land
    // observes), so what surfaces read is re-derived from it, never replayed (land.ts outstandingConflicts).
    conflicts: z.array(LandConflictSchema).optional(),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    // Completed turns + lifetime tool calls (optional: entries predating the counters read as absent).
    turns: z.number().optional(),
    toolUses: z.number().optional(),
    /* How many agents this one has STARTED, for its whole life. Counted here rather than read off the subagent
     * registry, which is where the card's live half still comes from: that registry sweeps a finished child
     * five minutes after it reports (agent/subagents.ts) and holds nothing across a daemon restart, so a card
     * asked half an hour later said the agent had never delegated at all — for work that may have been most of
     * what the turn did. What is live is a fact about right now and belongs in memory; what an agent HAS DONE
     * belongs on the entry, beside its turns and its tool calls. */
    subagents: z.number().optional(),
    // Cumulative base→tip output across the composition, refreshed on each land — the card's diffstat.
    diffFiles: z.number().optional(),
    diffInsertions: z.number().optional(),
    diffDeletions: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    // When the agent was last opened (ms epoch) — the unread badge's reference point, kept HERE rather than in
    // a browser so it survives a cache wipe and holds across every device the fleet is driven from. Absent ⇒
    // never opened.
    seenAt: z.number().optional(),
    // When the agent was archived (ms epoch) — off the board, checkout retired, branch kept. Absent ⇒ live.
    // The entry survives archiving in full: this is a presentation state plus a disk reclaim, not a deletion,
    // so cost/usage/attribution keep answering for it and a new turn clears the stamp (see registry.begin).
    archivedAt: z.number().optional(),
});
export type PersistedAgent = z.infer<typeof PersistedAgentSchema>;

/* A conversation that owns a worktree, as a TYPE rather than a runtime re-test. `branch` is the placement
 * discriminator, so every branch-only path (the diff/land/discard routes, land.ts, the land standings) takes
 * this and the compiler carries the guarantee — rather than each of them re-checking `branch !== undefined` and
 * inventing its own answer for a workspace conversation that could never reach it. */
export type IsolatedAgent = PersistedAgent & { branch: string };
export const isIsolated = (entry: PersistedAgent): entry is IsolatedAgent => entry.branch !== undefined;

export interface AgentsStore {
    readonly load: () => Promise<PersistedAgent[]>;
    // Full-replace write (the registry owns the authoritative in-memory array after init).
    readonly save: (agents: readonly PersistedAgent[]) => Promise<void>;
}

/* This file is the fleet's ONLY record of which conversations exist — archived ones included, whose whole
 * promise is "nothing is lost". The registry write-through persists the in-memory array on every mutation, so
 * a load that answers a bad file with `[]` doesn't merely start one boot empty: the first mutation after it
 * WRITES that emptiness back, and every agent the sandbox ever ran is gone for good. Both halves below exist
 * to make that impossible:
 *   · save is atomic (tmp + rename) — a daemon killed mid-write (a container rebuild deploys one on every
 *     update here) leaves the previous file intact instead of a truncated one
 *   · load never lets what it couldn't read be overwritten — an unparseable file is set ASIDE, an invalid
 *     entry is dropped alone. Only a file that is genuinely absent reads as a fresh sandbox. */
export const fileAgentsStore = (path: string): AgentsStore => ({
    load: async () => {
        let raw: string;
        try {
            raw = await readFile(path, "utf8");
        } catch {
            return []; // Absent ⇒ a fresh sandbox — the one case where an empty fleet is the truth.
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(raw);
        } catch {
            // The file exists but isn't JSON (a torn write from before saves were atomic, a stray editor).
            // Returning [] here with the file still in place is how one bad boot used to erase the fleet: move
            // the bytes out of the write path so the next persist cannot overwrite the only copy of them.
            await rename(path, `${path}.corrupt`).catch(() => undefined);
            return [];
        }
        if (!Array.isArray(parsed)) {
            await rename(path, `${path}.corrupt`).catch(() => undefined);
            return [];
        }
        // Per entry, not the array at once: one row a schema change no longer accepts must cost that row, not
        // the whole roster it sits in.
        return parsed.flatMap((entry) => {
            const result = PersistedAgentSchema.safeParse(entry);
            return result.success ? [result.data] : [];
        });
    },
    // Write-then-rename so the file is always one COMPLETE roster or the previous one — never a prefix. Through
    // the shared writer because agents.json sits ON /history, the volume a second daemon (a dev sandbox pointed
    // at the same one) shares: the temp has to be tagged with the writing daemon's pid, and the plain
    // "<path>.tmp" this hand-rolled was the one temp name in the daemon that wasn't.
    save: (agents) => writeJsonFile(path, agents),
});
