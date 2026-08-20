import { readFile, rename } from "node:fs/promises";
import {
    AgentHarnessSchema,
    AgentOriginSchema,
    AgentProviderSchema,
    ForkedFromSchema,
    LandConflictSchema,
    type LandedMessage,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { writeJsonFile } from "../store/json-file.js";

// The persisted half of the fleet registry (<historyRoot>/agents.json, on the /history volume so a
// conversation's identity survives container rebuilds alongside any worktree it owns). One entry per
// conversation. Runtime-only state (running/awaiting, attention, activity, context fill) lives in the
// registry's memory and is rebuilt from turn frames; only what must survive a restart is here.

/* THE TURN LIFECYCLE, and nothing else. Every value here is an EVENT, how the last turn ended, which is
 * exactly the class of fact nothing but this entry remembers. running/awaiting are excluded because they are
 * rebuilt from the live turn's frames (a daemon restart mid-turn must rehydrate to a state the user can act
 * on), and ready/landed/conflict because they are not facts about the turn at all: they answer "does this
 * branch hold work the main line does not", which git answers live and correctly at any moment. Storing that
 * answer made a cache with no invalidation, and a card that outlived what it described, see standing.ts.
 *
 * `interrupted` is what a LIVE turn leaves here, written by registry.begin, overwritten by registry.finish.
 * The value on disk while a turn runs is therefore the one that should stand if the daemon never comes back,
 * which is the only way to get this right: the daemon does not get to write a parting state. Its container is
 * recreated with `docker rm -f` on every rebuild (dev-sandbox.sh) and it is equally free to be OOM-killed, so
 * anything that depended on a graceful shutdown, or on a boot pass repairing a "running" marker, would be
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
 * It is narrower than "the user ended it", though, and deliberately: a turn ended by DISMISSING its question
 * writes the resting `idle` here instead. Both endings are the user's, but pressing Stop reaches in to halt
 * work they still wanted, the card waits in Attention to be picked up, while waving a question away says
 * they are done with it, and nothing is owed. What the turn wrote is still on its branch either way.
 *
 * `.catch` rather than a bare enum, and the only field here that carries one: agents.json is user data on a
 * volume that outlives every image, so this field's vocabulary shrinking must cost the VALUE, not the row. The
 * per-entry parse below already treats losing a row as a cost to be minimised; a status that no longer exists
 * reads as the resting one, which is what every retired value meant, the turn ended and the land question is
 * now asked of git. */
const PersistedAgentStatusSchema = z.enum(["idle", "interrupted", "stopped", "error"]).catch("idle");

/* Where a title came from, which is the whole of what decides whether a better one may replace it. The ladder
 * is one question asked four times, how much authority does whoever wrote this name have over the job?
 *
 * `derived` is the opening prompt CUT to a line by a rule with no model behind it (deriveTitle), which is the
 * best that can be done before the first frame comes back. `model` is the quick model's name for the same
 * prompt (agent/title-namer.ts): it writes rather than cuts, so it beats the guess. `plan` is the heading of a
 * plan the agent wrote, its own name for the whole job, better than any reading of the ask alone. `user` is a
 * rename, which outranks everything: an agent that renames a tab the user just named is a bug.
 *
 * `.catch`, for the reason PersistedAgentStatusSchema carries one: agents.json is user data on a volume that
 * outlives every image, so a value retired from this vocabulary must cost the FIELD and not the row. Reading a
 * retired source as `derived` says exactly what losing it means, the name that is there stands until anything
 * better arrives, which is the resting state of every title. */
const AgentTitleSourceSchema = z.enum(["derived", "model", "plan", "user"]).catch("derived");
export type AgentTitleSource = z.infer<typeof AgentTitleSourceSchema>;

export const PersistedAgentSchema = z.object({
    // The conversationId. `branch` is the placement discriminator: present for an isolated conversation,
    // absent for one that works directly in the shared workspace.
    id: z.string(),
    branch: z.string().optional(),
    // The display name, sanitized to one bounded line, derived from the opening prompt, promoted to a plan's
    // heading, or chosen outright by a rename. `titleSource` says which, and gates the next promotion.
    title: z.string().optional(),
    titleSource: AgentTitleSourceSchema.optional(),
    provider: AgentProviderSchema,
    harness: AgentHarnessSchema,
    // The turn settings this conversation last ran under, see AgentSummarySchema. Persisted because a client
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
    // Where this conversation was cut from, when it is a fork of another (ForkedFromSchema). Written from the
    // fork's first turn and never cleared, both ends of the relationship read it from here.
    forkedFrom: ForkedFromSchema.optional(),
    // The worktree composition: each workspace repo ("root" or a repo id, its root-relative dir) with the full
    // sha its worktree sits on the main line at, and the branch tip whose delta has already LANDED into the main
    // tree (absent ⇒ nothing landed yet, the base is the reference). Land applies `landedTip → tip`, so each
    // land carries only the new delta; the review reads `base` and flags each file against `landedTip`.
    //
    // `base` MOVES: the pre-turn rebase advances it whenever the main line has run ahead of the branch
    // (agents/sync.ts), so it is where the branch stands rather than where it started. `landedTip` does not
    // follow it, that sha is the provenance of a land that really happened, and a rewrite that orphans it is
    // exactly the case anchorOf falls through to the merge-base for (agents/agent-changes.ts).
    //
    // `landedHead`/`landedAt` are that land's provenance in the MAIN tree: the commit HEAD stood on and when.
    // They are what lets the Changes panel say which agent an uncommitted file came from, `base → landedTip`
    // names the paths, and a HEAD that has since moved retires the claim (see agents/origins.ts).
    //
    // `absorbed` records the landing's one terminal fact: history has taken every path this land put in the
    // tree (the user committed all of it), at which point no later act of theirs can make the work missing,
    // an edit-and-discard returns to the commit that holds it. Its value is the landing's SIZE (the count of
    // paths it actually applied), because the presence reading is a fraction and a settled repo still belongs
    // in the denominator. Written once, by the attribution scan that observes the absorption (agents/origins.ts
    // via registry.markLandingAbsorbed), and cleared for free by the next land, which writes a fresh row. It
    // is what keeps the per-scan attribution cost proportional to the ACTIVE landings rather than to everything
    // the fleet has ever landed, the in-memory memos it replaces (`spent`/`settled`) re-derived the same
    // one-way fact from hundreds of git spawns on the first scan after every restart.
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
    /* WHAT THE LANDED WORK DID, as a commit subject, drafted from the diff the moment it reached the main tree
     * (agents/landed-subject.ts), for the Changes panel's "From" chip to file into the commit box.
     *
     * Kept HERE rather than derived on demand for two reasons. It is written from a MODEL call, so deriving it
     * when the panel asks would put a second of latency and a quota charge behind a click that is meant to be
     * free and instant. And the moment it is cheapest to know is the moment the work arrives: the diff is
     * already in hand and nobody is waiting on it.
     *
     * Persisted alongside the landed shas because it describes the same thing they do, a claim on the main
     * tree that outlives the card. Archiving the agent does not commit its lines, and land-archive-commit-later
     * is the ordinary flow, so a subject held only in memory would be gone exactly when the chip needs it.
     * Overwritten by the next land (the claim grows; so does the sentence about it) and left alone otherwise,
     * a commit expires the claim, and the entry going quiet is what retires this with it. */
    landedSubject: z.string().optional(),
    // The user-facing sentence for the same landing, when this repo keeps a changelog, see OriginAgent.note for
    // why it is stored apart from the subject rather than as a second line of it. Persisted for the same reason
    // the subject is: the commit that carries it is usually made long after the land that wrote it.
    landedNote: z.string().optional(),
    // The breaking sentence for the same landing, what this change TAKES AWAY from users, destined for the
    // Release's "Breaking changes" section via the `Breaking-Note:` trailer. Almost always absent.
    landedBreaking: z.string().optional(),
    status: PersistedAgentStatusSchema,
    // Why the last turn failed, the EVIDENCE behind an errored card, the same role `conflicts` below plays for
    // a refused land (see AgentSummarySchema). Persisted rather than held in the turn's runtime state because
    // the reader who needs it most arrives hours later, at a card nobody watched fail; a fresh turn rebuilds the
    // entry without it, which is what clears it.
    failure: z.string().optional(),
    // Per-agent override of the sandbox-wide autoLand setting, absent ⇒ inherit, see AgentSummarySchema.
    // Persisted because it must govern turns that finish with no browser attached (automations included).
    autoLand: z.boolean().optional(),
    // Per-agent override of the sandbox-wide resumeAfterOutage setting, absent ⇒ inherit, see
    // AgentSummarySchema. Persisted for a sharper reason than autoLand's: the whole point of arming a
    // conversation is that the resume happens with nobody watching, and an outage regularly outlives the
    // browser tab that answered the offer.
    resumeAfterOutage: z.boolean().optional(),
    // A collaborator's standing ask for this work to be landed (see AgentSummarySchema.landRequested).
    // Persisted so the ask survives a daemon restart, the maintainer it waits for may arrive tomorrow.
    landRequested: z.object({ email: z.string(), name: z.string().optional(), at: z.number() }).optional(),
    // Why the last land refused, the EVIDENCE behind a conflicted card, which is a different thing from the
    // card's state: standing.ts reads this only to explain an outstanding delta, never to create one, so a
    // report whose delta has since gone stops being rendered without needing to be rewritten. Written and
    // cleared by the same recordLanded that advances the tips, but its per-path CONTENT is a snapshot of
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
     * asked half an hour later said the agent had never delegated at all, for work that may have been most of
     * what the turn did. What is live is a fact about right now and belongs in memory; what an agent HAS DONE
     * belongs on the entry, beside its turns and its tool calls. */
    subagents: z.number().optional(),
    // Cumulative base→tip output across the composition, refreshed on each land, the card's diffstat.
    diffFiles: z.number().optional(),
    diffInsertions: z.number().optional(),
    diffDeletions: z.number().optional(),
    createdAt: z.number(),
    updatedAt: z.number(),
    // When the agent was last opened (ms epoch), the unread badge's reference point, kept HERE rather than in
    // a browser so it survives a cache wipe and holds across every device the fleet is driven from. Absent ⇒
    // never opened.
    seenAt: z.number().optional(),
    // When the agent was archived (ms epoch), off the board, checkout retired, branch kept. Absent ⇒ live.
    // The entry survives archiving in full: this is a presentation state plus a disk reclaim, not a deletion,
    // so cost/usage/attribution keep answering for it and a new turn clears the stamp (see registry.begin).
    archivedAt: z.number().optional(),
});
export type PersistedAgent = z.infer<typeof PersistedAgentSchema>;

/* A conversation that owns a worktree, as a TYPE rather than a runtime re-test. `branch` is the placement
 * discriminator, so every branch-only path (the diff/land/discard routes, land.ts, the land standings) takes
 * this and the compiler carries the guarantee, rather than each of them re-checking `branch !== undefined` and
 * inventing its own answer for a workspace conversation that could never reach it. */
export type IsolatedAgent = PersistedAgent & { branch: string };
export const isIsolated = (entry: PersistedAgent): entry is IsolatedAgent => entry.branch !== undefined;

/* THE DRAFTED COMMIT MESSAGE THIS ENTRY HOLDS, as the one shape both of its readers hand out, the agent's own
 * card (live, dropped when the agent is archived) and the review's origin record (a rescan, outliving the
 * card). Stored as three flat columns because that is what a record of a claim looks like; handed out as one
 * value because that is what a commit message is, and because a reader that gets it from either road must not
 * have to know which.
 *
 * Undefined when no sentence has been written for this agent's landing, the ordinary state before the first
 * land, in the seconds while the model is still writing, and forever after a draft that failed. The notes only
 * ever ride WITH a subject: a release note over no subject would be a trailer with nothing to trail. */
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
    // Full-replace write (the registry owns the authoritative in-memory array after init).
    readonly save: (agents: readonly PersistedAgent[]) => Promise<void>;
}

/* This file is the fleet's ONLY record of which conversations exist, archived ones included, whose whole
 * promise is "nothing is lost". The registry write-through persists the in-memory array on every mutation, so
 * a load that answers a bad file with `[]` doesn't merely start one boot empty: the first mutation after it
 * WRITES that emptiness back, and every agent the sandbox ever ran is gone for good. Both halves below exist
 * to make that impossible:
 *   · save is atomic (tmp + rename), a daemon killed mid-write (a container rebuild deploys one on every
 *     update here) leaves the previous file intact instead of a truncated one
 *   · load never lets what it couldn't read be overwritten, an unparseable file is set ASIDE, an invalid
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
    // Write-then-rename so the file is always one COMPLETE roster or the previous one, never a prefix. Through
    // the shared writer because agents.json sits ON /history, the volume a second daemon (a dev sandbox pointed
    // at the same one) shares: the temp has to be tagged with the writing daemon's pid, and the plain
    // "<path>.tmp" this hand-rolled was the one temp name in the daemon that wasn't.
    save: (agents) => writeJsonFile(path, agents),
});
