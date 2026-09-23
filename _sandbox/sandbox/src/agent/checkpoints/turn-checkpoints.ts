import { z } from "zod";
import type { ConversationsDb } from "../../store/conversations-db.js";

// What each message can go back to: `tree` (workspace-history checkpoint) or `worktree` (a commit per repo on its own
// branch); both share one table keyed by `kind`, not by asking the registry which placement applies. Keyed by
// (conversation, index), not the commit itself: a turn's start state is usually not a new commit (a clean-tree capture
// is a no-op), so the id may already belong to another turn and can't be re-stamped after the fact.

const AnchorSchema = z.union([
    z.object({ kind: z.literal("tree"), snapshot: z.string().min(1) }),
    z.object({ kind: z.literal("worktree"), repos: z.array(z.object({ repo: z.string(), base: z.string().min(1) })).min(1) }),
]);
export type TurnCheckpoint = z.infer<typeof AnchorSchema>;

export interface TurnCheckpoints {
    // Remember what this conversation's message `index` can be put back to; the conversation must be registered.
    readonly record: (conversationId: string, index: number, checkpoint: TurnCheckpoint) => Promise<void>;
    // The checkpoint for one message, or undefined if none was ever recorded.
    readonly of: (conversationId: string, index: number) => Promise<TurnCheckpoint | undefined>;
    // Every bound index for a conversation, for stamping a transcript being read back.
    readonly all: (conversationId: string) => Promise<ReadonlyMap<number, TurnCheckpoint>>;
    // Drops checkpoints at or after `from`, so a second rewind can't offer a turn the first one already dropped.
    readonly truncate: (conversationId: string, from: number) => Promise<void>;
}

// A row this build can no longer read is no checkpoint, the same answer as one never recorded.
const anchorOf = (raw: string): TurnCheckpoint | undefined => AnchorSchema.safeParse(JSON.parse(raw)).data;

// Kept as long as the conversation is: its rows cascade from the conversation's, so a purge takes them and nothing else
// does.
export const sqliteTurnCheckpoints = ({ db }: ConversationsDb): TurnCheckpoints => {
    const upsert = db.prepare(
        "INSERT INTO checkpoint(conversation_id, message, anchor) VALUES (?, ?, ?) ON CONFLICT(conversation_id, message) DO UPDATE SET anchor = excluded.anchor",
    );
    const selectOne = db.prepare("SELECT anchor FROM checkpoint WHERE conversation_id = ? AND message = ?");
    const selectAll = db.prepare("SELECT message, anchor FROM checkpoint WHERE conversation_id = ? ORDER BY message");
    const dropFrom = db.prepare("DELETE FROM checkpoint WHERE conversation_id = ? AND message >= ?");
    return {
        record: async (conversationId, index, checkpoint) => {
            upsert.run(conversationId, index, JSON.stringify(checkpoint));
        },
        of: async (conversationId, index) => {
            const row = selectOne.get(conversationId, index) as { anchor: string } | undefined;
            return row === undefined ? undefined : anchorOf(row.anchor);
        },
        all: async (conversationId) =>
            new Map(
                (selectAll.all(conversationId) as unknown as { message: number; anchor: string }[]).flatMap(({ message, anchor }) => {
                    const checkpoint = anchorOf(anchor);
                    return checkpoint === undefined ? [] : [[message, checkpoint] as const];
                }),
            ),
        truncate: async (conversationId, from) => {
            dropFrom.run(conversationId, from);
        },
    };
};
