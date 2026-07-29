import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { AgentHarnessSchema, AgentOriginSchema, AgentProviderSchema, LandConflictSchema } from "@intentic/sandbox-contract";
import { z } from "zod";

// The persisted half of the fleet registry (<historyRoot>/agents.json — on the /history volume so a
// conversation's identity survives container rebuilds alongside its worktree). One entry per ISOLATED
// conversation. Runtime-only state (running/awaiting, attention, activity, context fill) lives in the
// registry's memory and is rebuilt from turn frames; only what must survive a restart is here.

/* Persisted status excludes the transient running/awaiting — a daemon restart mid-turn must rehydrate to a
 * state the user can act on (the turn itself is gone). `ready` IS persisted: a held delta waits on the branch
 * across restarts exactly as it waits across turns, and rehydrating it to `idle` would hide work from review.
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
 * process holding it, came back indistinguishable from one that had nothing left to do. */
const PersistedAgentStatusSchema = z.enum(["idle", "interrupted", "ready", "landed", "conflict", "error"]);

/* Where a title came from, which is the whole of what decides whether a better one may replace it.
 *
 * `derived` is the opening prompt read as prose (deriveTitle) — a guess made before the first frame came
 * back. `summary` is the quick model's reading of a finished turn (agent/title-summary.ts): it has seen the
 * answer, so it beats the guess. `plan` is the heading of a plan the agent wrote — its own name for the whole
 * job, better than any reading of it. `user` is a rename, which outranks everything: an agent that renames a
 * tab the user just named is a bug. */
const AgentTitleSourceSchema = z.enum(["derived", "summary", "plan", "user"]);
export type AgentTitleSource = z.infer<typeof AgentTitleSourceSchema>;

export const PersistedAgentSchema = z.object({
    // The conversationId — also the worktree dir name and the agent/<id> branch suffix.
    id: z.string(),
    branch: z.string(),
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
    account: z.string().optional(),
    sessionId: z.string().optional(),
    // Set when an automation opened this conversation for an outside message (a Discord mention, a web-chat
    // visitor, a webhook) instead of the user starting it. Absent ⇒ a user-started agent.
    origin: AgentOriginSchema.optional(),
    // The worktree composition: each workspace repo ("root" or a repo id — its root-relative dir) with the full
    // base sha its worktree branched from, and the branch tip whose delta has already LANDED into the main
    // tree (absent ⇒ nothing landed yet — the base is the reference). Land applies `landedTip → tip`, so each
    // land carries only the new delta; the review reads `base` and flags each file against `landedTip`.
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
    // Per-agent override of the sandbox-wide autoLand setting, absent ⇒ inherit — see AgentSummarySchema.
    // Persisted because it must govern turns that finish with no browser attached (automations included).
    autoLand: z.boolean().optional(),
    // Why the last land refused, kept alongside the `conflict` status it produced — the two are one fact, and
    // a status the UI can render but not explain is what makes a conflicted card a dead end. Written and
    // cleared by the same recordLanded that advances the tips, so it is exactly as current as they are.
    conflicts: z.array(LandConflictSchema).optional(),
    costUsd: z.number(),
    inputTokens: z.number(),
    outputTokens: z.number(),
    // Completed turns + lifetime tool calls (optional: entries predating the counters read as absent).
    turns: z.number().optional(),
    toolUses: z.number().optional(),
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
    save: async (agents) => {
        await mkdir(dirname(path), { recursive: true });
        // Write-then-rename so the file is always one COMPLETE roster or the previous one — never a prefix.
        const tmp = `${path}.tmp`;
        await writeFile(tmp, `${JSON.stringify(agents, undefined, 2)}\n`);
        await rename(tmp, path);
    },
});
