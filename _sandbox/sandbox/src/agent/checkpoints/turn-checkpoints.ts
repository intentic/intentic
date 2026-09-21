import { z } from "zod";
import { jsonFile } from "../../store/json-file.js";

// What each message can go back to: `tree` (workspace-history checkpoint) or `worktree` (a commit per repo on its own
// branch); both share one store keyed by `kind`, not by asking the registry which placement applies. Keyed by
// (conversation, index), not the commit itself: a turn's start state is usually not a new commit (a clean-tree capture
// is a no-op), so the id may already belong to another turn and can't be re-stamped after the fact.

const AnchorSchema = z.union([
    z.object({ kind: z.literal("tree"), snapshot: z.string().min(1) }),
    z.object({ kind: z.literal("worktree"), repos: z.array(z.object({ repo: z.string(), base: z.string().min(1) })).min(1) }),
]);
export type TurnCheckpoint = z.infer<typeof AnchorSchema>;

// index → checkpoint, per conversation; object-keyed since indices are sparse (an uncheckpointed turn files nothing).
const FileSchema = z.record(z.string(), z.record(z.string(), AnchorSchema));
type CheckpointsFile = z.infer<typeof FileSchema>;

// Bounds one conversation's checkpoints so the file stays bounded; oldest indices evict first, only recent turns matter.
const MAX_ANCHORS_PER_CONVERSATION = 200;
// Same bound one level up: conversations evicted by least-recently-touched.
const MAX_CONVERSATIONS = 500;

export interface TurnCheckpoints {
    // Remember what this conversation's message `index` can be put back to.
    readonly record: (conversationId: string, index: number, checkpoint: TurnCheckpoint) => Promise<void>;
    // The checkpoint for one message, or undefined if none was ever recorded or it's since been evicted.
    readonly of: (conversationId: string, index: number) => Promise<TurnCheckpoint | undefined>;
    // Every bound index for a conversation, for stamping a transcript being read back.
    readonly all: (conversationId: string) => Promise<ReadonlyMap<number, TurnCheckpoint>>;
    // Drops checkpoints at or after `from`, so a second rewind can't offer a turn the first one already dropped.
    readonly truncate: (conversationId: string, from: number) => Promise<void>;
}

const trimmed = (checkpoints: Record<string, TurnCheckpoint>): Record<string, TurnCheckpoint> => {
    const keys = Object.keys(checkpoints);
    if (keys.length <= MAX_ANCHORS_PER_CONVERSATION) {
        return checkpoints;
    }
    const kept = keys
        .map(Number)
        .toSorted((a, b) => a - b)
        .slice(-MAX_ANCHORS_PER_CONVERSATION);
    return Object.fromEntries(kept.map((index) => [String(index), checkpoints[String(index)] as TurnCheckpoint]));
};

// Same checkpoint by value; a turn re-run at the same index on a clean tree is the common repeat, letting the write be
// skipped.
const same = (a: TurnCheckpoint | undefined, b: TurnCheckpoint): boolean => {
    if (a === undefined || a.kind !== b.kind) {
        return false;
    }
    if (a.kind === "tree" && b.kind === "tree") {
        return a.snapshot === b.snapshot;
    }
    if (a.kind === "worktree" && b.kind === "worktree") {
        return a.repos.length === b.repos.length && a.repos.every((repo, at) => repo.repo === b.repos[at]?.repo && repo.base === b.repos[at]?.base);
    }
    return false;
};

export const fileTurnCheckpoints = (path: string): TurnCheckpoints => {
    const file = jsonFile<CheckpointsFile>(path, {
        parse: (raw) => FileSchema.safeParse(raw).data,
        fallback: () => ({}),
    });

    return {
        record: async (conversationId, index, checkpoint) => {
            await file.update((current) => {
                const existing = current[conversationId];
                if (same(existing?.[String(index)], checkpoint)) {
                    // Unchanged by reference ⇒ jsonFile skips the write.
                    return current;
                }
                const checkpoints = trimmed({ ...existing, [String(index)]: checkpoint });
                // Re-inserted last so key order is recency order; eviction below is then a plain slice, no timestamp
                // needed.
                const { [conversationId]: _moved, ...rest } = current;
                const next = { ...rest, [conversationId]: checkpoints };
                const ids = Object.keys(next);
                return ids.length <= MAX_CONVERSATIONS
                    ? next
                    : Object.fromEntries(ids.slice(-MAX_CONVERSATIONS).map((id) => [id, next[id] as Record<string, TurnCheckpoint>]));
            });
        },
        of: async (conversationId, index) => (await file.read())[conversationId]?.[String(index)],
        all: async (conversationId) =>
            new Map(Object.entries((await file.read())[conversationId] ?? {}).map(([index, checkpoint]) => [Number(index), checkpoint])),
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
