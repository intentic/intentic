import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentHarnessSchema, AgentProviderSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { writeJsonFile } from "../store/json-file.js";

/* WHAT AN ARMED WATCH IS, written down where the process cannot take it with it, the turn journal's argument
 * applied to the one other thing in the daemon that outlives a turn on purpose.
 *
 * A watch is armed at the end of one turn and fires hours later with nothing else moving on the board, so the
 * daemon dying under it is not an edge case, it is the ordinary case: the container is recreated on every
 * update, every environment approval and every `dev-sandbox.sh` swap, and intentic's own flows are therefore
 * the most common way a watch dies. Held only in memory (watchers.ts `records`), such a death was SILENT, no
 * fire, no timeout wake, and the card's readout gone with the projection, which is exactly the outcome
 * watchers.ts opens by saying can never happen ("silence is never an outcome"). This file is what makes that
 * true across a restart.
 *
 * NO CREDENTIAL IS PERSISTED, which is what the in-memory design was protecting and what it gave up the whole
 * feature to protect. A check's environment is the turn's capability credentials, and writing those to disk
 * would be a worse trade than losing the watch. So the journal keeps the environment's SHAPE and never its
 * substance: `envKeys`, the variable NAMES the arming turn ran with. At boot the values come fresh from the
 * live capability store and are narrowed to those names, which reproduces both filters that produced them for
 * free, the persona's withholding (personas.ts `personaCliEnv` only ever REMOVES keys, so intersecting on the
 * arming turn's key set withholds exactly what it withheld) and the world having moved: a capability revoked
 * while the daemon was down has no value to find, and one connected while it was down is not in the key set
 * and so is not quietly granted to a check nobody re-authorised. A rotated token is picked up rather than
 * resurrected, the same contract turn-journal keeps by re-resolving its turn instead of snapshotting it.
 *
 * ON THE HISTORY VOLUME, beside turns/: it must outlive the container recreates that cause the deaths, and it
 * is daemon-private, outside the agent's reach. One file per watch, never a shared manifest, concurrent arms
 * would race a read-modify-write, the same argument the approvals queue and the turn journal both make.
 *
 * THE FILE IS THE ARMING, not a mirror of the live record. It is written once when the watch arms and deleted
 * the moment the watch ENDS for any reason a person or the agent chose (fired, timed out, stopped, its
 * conversation discarded), and it is deliberately NOT rewritten per check: `checks` and the last output are
 * worth nothing after a restart, because restore re-checks before it decides anything. A journal rewritten
 * every interval would be this module's own busy-loop, wearing a different hat. */

// The charset ConversationIdSchema and the watch ids (`watch-3`) share; a filename that doesn't match is
// ignored, never trusted, the same rule the turn journal and the approvals queue apply.
const FILE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

const JournalledWatchSchema = z.object({
    id: z.string(),
    conversationId: z.string(),
    // The check, verbatim. Already gated against the owner's command rulebook when it armed (watch-server.ts);
    // restore re-runs what was admitted, and a rulebook tightened since is applied on the next arm, not here.
    command: z.string(),
    note: z.string(),
    intervalMs: z.number(),
    // The ORIGINAL arm, kept across the restart so a restored watch's wake still says how long the agent has
    // actually been waiting rather than how long ago the daemon came back.
    armedAt: z.number(),
    // The deadline is the staleness test, so this journal needs no max-age of its own: a watch may not be
    // armed for longer than a day (watchers.ts MAX_TIMEOUT_S), and one whose deadline passed while the daemon
    // was down is woken as expired rather than re-armed.
    deadlineAt: z.number(),
    // The tree the check runs in. An isolated conversation's worktree, which survives on disk; a restore that
    // cannot find it again drops the watch rather than silently re-running the check somewhere else.
    cwd: z.string(),
    // The NAMES of the environment the check ran with, never the values. See the header.
    envKeys: z.array(z.string()),
    // The turn identity the wake must reproduce (watchers.ts WatcherTurnSeed). `sessionId` is absent on
    // purpose, it is looked up at fire time, since the conversation may advance while the watch runs.
    turn: z.object({
        agent: AgentProviderSchema.optional(),
        harness: AgentHarnessSchema.optional(),
        account: z.string().optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        isolated: z.boolean().optional(),
        unattended: z.boolean().optional(),
    }),
});
export type JournalledWatch = z.infer<typeof JournalledWatchSchema>;

export interface WatchJournal {
    // Every armed watch, which after a boot means every watch the daemon died under.
    readonly list: () => Promise<JournalledWatch[]>;
    readonly record: (watch: JournalledWatch) => Promise<void>;
    // Awaited by every caller that ENDS a watch, deliberately: "the user stopped it and the container was
    // recreated a moment later" must not be a way for a disarmed watch to come back from the dead.
    readonly drop: (id: string) => Promise<void>;
}

// A per-file JSON store, used in production at <historyRoot>/watches/.
export const fileWatchJournal = (dir: string): WatchJournal => ({
    list: async () => {
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            // No directory means nothing was ever armed here, which is the overwhelmingly common boot.
            return [];
        }
        const entries: JournalledWatch[] = [];
        for (const name of names.filter((file) => file.endsWith(".json"))) {
            if (!FILE_ID.test(name.slice(0, -".json".length))) {
                continue;
            }
            // An entry that won't parse is SKIPPED, never deleted, the turn journal's rule and its reason: a
            // file caught mid-write parses as garbage for an instant, and a lister that answered that by
            // unlinking would delete the record of a watch that had only just armed.
            try {
                const parsed = JournalledWatchSchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8")));
                if (parsed.success) {
                    entries.push(parsed.data);
                }
            } catch {
                continue;
            }
        }
        return entries;
    },
    // The same sibling-temp + atomic-rename write every manifest store gets: this is precisely the file we
    // need after a crash, so it must never be found half-written.
    record: (watch) => writeJsonFile(join(dir, `${watch.id}.json`), watch),
    // A drop that finds nothing has nothing to do: the watch ended twice, or a boot pass already took it.
    drop: async (id) => {
        if (!FILE_ID.test(id)) {
            return;
        }
        await unlink(join(dir, `${id}.json`)).catch(() => undefined);
    },
});

/* The journal the tests and the conversationless bench run on: the same contract with no disk behind it, so a
 * watcher runtime always has one and nothing has to branch on its absence. */
export const memoryWatchJournal = (): WatchJournal => {
    const entries = new Map<string, JournalledWatch>();
    return {
        list: () => Promise.resolve([...entries.values()]),
        record: (watch) => {
            entries.set(watch.id, watch);
            return Promise.resolve();
        },
        drop: (id) => {
            entries.delete(id);
            return Promise.resolve();
        },
    };
};
