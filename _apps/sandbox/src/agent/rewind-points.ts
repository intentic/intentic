import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* WHICH CHECKPOINT EACH MESSAGE CAN GO BACK TO — the durable half of the rewind affordance.
 *
 * The daemon already picks a pre-turn checkpoint for every main-tree turn and ships it to the client as the
 * `checkpoint` frame (agent.routes), which is what today's "restore to before this message" hangs on. That
 * frame is the RIGHT id — the state as the agent found it, not as it left it — and it is also gone the moment
 * the tab reloads: the transcript comes back from the daemon's record, and a RestoredMessage carries no
 * checkpoint. So the one affordance that answers "undo this" was available for exactly as long as the browser
 * that watched the turn stayed open, which is the opposite of when it is wanted.
 *
 * WHY A MAP AND NOT THE COMMIT. The obvious alternative is to stamp the turn onto the snapshot commit itself
 * and read it back out of `git log`. It does not work, and the reason is worth writing down: the turn-start
 * checkpoint is USUALLY NOT A NEW COMMIT. The fence snapshot is a no-op when the tree is clean — the common
 * case by far — and the id then refers to an EXISTING checkpoint, which may already belong to another turn and
 * cannot be re-stamped after the fact. A map keyed by (conversation, index) says the one thing that is true in
 * both branches: this message's before-state is that checkpoint. Several messages naming the same checkpoint
 * is not a conflict, it is what a run of turns that changed nothing looks like.
 *
 * On the HISTORY volume beside the transcripts and the journal: daemon-private, outside the agent's reach, and
 * surviving the container rebuilds that recreate everything under ~/. */

// index → snapshot id, per conversation. Object-keyed rather than an array because the indices are sparse:
// only main-tree turns get a checkpoint (an isolated turn never touches the tree history captures).
const FileSchema = z.record(z.string(), z.record(z.string(), z.string()));
type PointsFile = z.infer<typeof FileSchema>;

/* Bound so one conversation cannot grow this without limit, and so the file stays a file. Oldest INDICES go
 * first, which is the right end: rewinding to the top of a thousand-turn conversation is not what the
 * affordance is for, and the recent turns are the ones anyone reaches back into. */
const MAX_POINTS_PER_CONVERSATION = 200;
// Conversations, evicted by which was touched least recently — same shape of bound, one level up.
const MAX_CONVERSATIONS = 500;

export interface RewindPoints {
    // Remember that this conversation's message `index` can be restored to `snapshotId`.
    readonly record: (conversationId: string, index: number, snapshotId: string) => Promise<void>;
    // The checkpoint for one message, or undefined when it has none (an isolated turn, a turn from before this
    // file existed, or a conversation that has been evicted).
    readonly of: (conversationId: string, index: number) => Promise<string | undefined>;
    // Every bound index for a conversation, for stamping a transcript being read back.
    readonly all: (conversationId: string) => Promise<ReadonlyMap<number, string>>;
    // Drop the points at or after `from` — what a rewind does to the messages it just dropped, so a second
    // rewind cannot offer to go back to a turn that no longer exists.
    readonly truncate: (conversationId: string, from: number) => Promise<void>;
}

const trimmed = (points: Record<string, string>): Record<string, string> => {
    const keys = Object.keys(points);
    if (keys.length <= MAX_POINTS_PER_CONVERSATION) {
        return points;
    }
    const kept = keys.map(Number).toSorted((a, b) => a - b).slice(-MAX_POINTS_PER_CONVERSATION);
    return Object.fromEntries(kept.map((index) => [String(index), points[String(index)] as string]));
};

export const fileRewindPoints = (path: string): RewindPoints => {
    const file = jsonFile<PointsFile>(path, {
        parse: (raw) => FileSchema.safeParse(raw).data,
        fallback: () => ({}),
    });

    return {
        record: async (conversationId, index, snapshotId) => {
            await file.update((current) => {
                const existing = current[conversationId];
                if (existing?.[String(index)] === snapshotId) {
                    // Unchanged by reference ⇒ jsonFile skips the write. A turn re-run at the same index against
                    // the same clean tree is the common repeat, and it costs nothing.
                    return current;
                }
                const points = trimmed({ ...existing, [String(index)]: snapshotId });
                /* Re-inserted LAST so plain key order is recency order — which is what makes the eviction below
                 * a slice rather than a second timestamp per conversation to keep in step. */
                const { [conversationId]: _moved, ...rest } = current;
                const next = { ...rest, [conversationId]: points };
                const ids = Object.keys(next);
                return ids.length <= MAX_CONVERSATIONS
                    ? next
                    : Object.fromEntries(ids.slice(-MAX_CONVERSATIONS).map((id) => [id, next[id] as Record<string, string>]));
            });
        },
        of: async (conversationId, index) => (await file.read())[conversationId]?.[String(index)],
        all: async (conversationId) =>
            new Map(Object.entries((await file.read())[conversationId] ?? {}).map(([index, snapshot]) => [Number(index), snapshot])),
        truncate: async (conversationId, from) => {
            await file.update((current) => {
                const existing = current[conversationId];
                if (existing === undefined) {
                    return current;
                }
                const kept = Object.entries(existing).filter(([index]) => Number(index) < from);
                if (kept.length === Object.keys(existing).length) {
                    return current;
                }
                return { ...current, [conversationId]: Object.fromEntries(kept) };
            });
        },
    };
};
