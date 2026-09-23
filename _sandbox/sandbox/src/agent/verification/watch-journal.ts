import { TurnProfileSchema, WatchOutcomeSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import type { ConversationsDb } from "../../store/conversations-db.js";

// One row per armed or firing watch, deleted only once its wake landed; env var names only, never a credential.

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
    // The tree the check runs in; a restore that can't find it wakes the watch as broken, never runs elsewhere.
    cwd: z.string(),
    // An isolated conversation's world, rebuilt for every check; absent for the workspace root.
    placement: z.object({ worktree: z.string(), fenced: z.boolean() }).optional(),
    // The source a fetching check's output is outside content from.
    outside: z.string().optional(),
    // A local file whose appearance re-checks at once; the interval stays the floor.
    signalPath: z.string().optional(),
    // Set from firing until its wake has landed.
    firing: z
        .object({
            outcome: WatchOutcomeSchema,
            check: z.object({ exitCode: z.number().optional(), output: z.string(), broken: z.string().optional() }),
        })
        .optional(),
    // The NAMES of the environment the check ran with, never the values. See the header.
    envKeys: z.array(z.string()),
    // The arming turn's profile, which the wake runs as; `sessionId` is not part of it, looked up at fire time instead.
    // Every field of it: a field missing here is silently changed by a container recreate, the ordinary event.
    turn: TurnProfileSchema,
});
export type JournalledWatch = z.infer<typeof JournalledWatchSchema>;

export interface WatchJournal {
    // Every armed watch, which after a boot means every watch the daemon died under.
    readonly list: () => Promise<JournalledWatch[]>;
    // Filed under its conversation, whose row must exist; a purge takes it with the conversation.
    readonly record: (watch: JournalledWatch) => Promise<void>;
    // Awaited by every caller ending a watch, so a stop followed by a container recreate can't resurrect it.
    readonly drop: (id: string) => Promise<void>;
}

// A row this build can no longer read is skipped, never deleted, like the turn journal's.
const watchOf = (id: string, conversationId: string, raw: string): JournalledWatch[] => {
    const parsed = JournalledWatchSchema.safeParse({ ...JSON.parse(raw), id, conversationId });
    return parsed.success ? [parsed.data] : [];
};

export const sqliteWatchJournal = ({ db }: ConversationsDb): WatchJournal => {
    const upsert = db.prepare(
        "INSERT INTO watch(id, conversation_id, entry) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET conversation_id = excluded.conversation_id, entry = excluded.entry",
    );
    const selectAll = db.prepare("SELECT id, conversation_id, entry FROM watch ORDER BY rowid");
    const remove = db.prepare("DELETE FROM watch WHERE id = ?");
    return {
        list: async () =>
            (selectAll.all() as unknown as { id: string; conversation_id: string; entry: string }[]).flatMap((row) =>
                watchOf(row.id, row.conversation_id, row.entry),
            ),
        record: async ({ id, conversationId, ...entry }) => {
            upsert.run(id, conversationId, JSON.stringify(entry));
        },
        // A drop that finds nothing has nothing to do: the watch ended twice, or a boot pass already took it.
        drop: async (id) => {
            remove.run(id);
        },
    };
};

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
