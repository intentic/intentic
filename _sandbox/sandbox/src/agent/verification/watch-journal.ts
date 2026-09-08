import { readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { AgentHarnessSchema, AgentProviderSchema, isConversationId, ModelRoleSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { writeJsonFile } from "../../store/json-file.js";

// Persists an armed watch since a daemon death mid-wait is ordinary here, not an edge case; in-memory alone would go
// silent, no fire, no wake. Never persists a credential: only `envKeys` (names), re-resolved fresh from the live
// capability store at boot, so withholding, revocations and rotations apply naturally. One file per watch, written once
// at arm and deleted at end; never rewritten per check, since restore always re-checks first.

// The charset ConversationIdSchema and watch ids share; a filename that doesn't match is ignored, never trusted, same
// rule as the turn journal and approvals queue.
const JournalledWatchSchema = z.object({
    id: z.string(),
    conversationId: z.string(),
    // The check, verbatim, gated against the owner's rulebook when it armed; restore re-runs what was admitted.
    command: z.string(),
    note: z.string(),
    intervalMs: z.number(),
    // The original arm time, kept across a restart so the wake reports real wait time, not time since reboot.
    armedAt: z.number(),
    // The staleness test itself, so no separate max-age is needed: a deadline passed while down wakes as expired.
    deadlineAt: z.number(),
    // The tree the check runs in; a restore that can't find it drops the watch rather than running elsewhere.
    cwd: z.string(),
    // The NAMES of the environment the check ran with, never the values. See the header.
    envKeys: z.array(z.string()),
    // The turn identity the wake must reproduce; `sessionId` is absent on purpose, looked up at fire time instead.
    // Every field of it: a field missing here is silently changed by a container recreate, the ordinary event.
    turn: z.object({
        agent: AgentProviderSchema.optional(),
        harness: AgentHarnessSchema.optional(),
        account: z.string().optional(),
        model: z.string().optional(),
        effort: z.string().optional(),
        thinking: z.boolean().optional(),
        fast: z.boolean().optional(),
        // Which persona the arming turn wore; absent is the strict real answer, no card means no signed-in account.
        actsAs: z.string().optional(),
        isolated: z.boolean().optional(),
        unattended: z.boolean().optional(),
        // What JOB the arming turn was, carried so the wake stays that same job. Not a model fallback: the wake
        // already runs on the arming turn's own model (see agent/run/turn/turn-seed.ts).
        runRole: ModelRoleSchema.optional(),
    }),
});
export type JournalledWatch = z.infer<typeof JournalledWatchSchema>;

export interface WatchJournal {
    // Every armed watch, which after a boot means every watch the daemon died under.
    readonly list: () => Promise<JournalledWatch[]>;
    readonly record: (watch: JournalledWatch) => Promise<void>;
    // Awaited by every caller ending a watch, so a stop followed by a container recreate can't resurrect it.
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
            if (!isConversationId(name.slice(0, -".json".length))) {
                continue;
            }
            // An entry that won't parse is skipped, never deleted: a file caught mid-write reads as garbage for an
            // instant.
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
    // Sibling-temp plus atomic rename, like every manifest store: never found half-written after a crash.
    record: (watch) => writeJsonFile(join(dir, `${watch.id}.json`), watch),
    // A drop that finds nothing has nothing to do: the watch ended twice, or a boot pass already took it.
    drop: async (id) => {
        if (!isConversationId(id)) {
            return;
        }
        await unlink(join(dir, `${id}.json`)).catch(() => undefined);
    },
});

// The journal tests and the conversationless bench run on: same contract, no disk, so a watcher runtime never branches
// on its absence.
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
