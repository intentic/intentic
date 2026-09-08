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
export type TurnAnchor = z.infer<typeof AnchorSchema>;

// index → anchor, per conversation; object-keyed since indices are sparse (an unanchored turn files nothing).
const FileSchema = z.record(z.string(), z.record(z.string(), AnchorSchema));
type AnchorsFile = z.infer<typeof FileSchema>;

// Bounds one conversation's anchors so the file stays bounded; oldest indices evict first, only recent turns matter.
const MAX_ANCHORS_PER_CONVERSATION = 200;
// Same bound one level up: conversations evicted by least-recently-touched.
const MAX_CONVERSATIONS = 500;

export interface TurnAnchors {
    // Remember what this conversation's message `index` can be put back to.
    readonly record: (conversationId: string, index: number, anchor: TurnAnchor) => Promise<void>;
    // The anchor for one message, or undefined if none was ever recorded or it's since been evicted.
    readonly of: (conversationId: string, index: number) => Promise<TurnAnchor | undefined>;
    // Every bound index for a conversation, for stamping a transcript being read back.
    readonly all: (conversationId: string) => Promise<ReadonlyMap<number, TurnAnchor>>;
    // Drops anchors at or after `from`, so a second rewind can't offer a turn the first one already dropped.
    readonly truncate: (conversationId: string, from: number) => Promise<void>;
}

const trimmed = (anchors: Record<string, TurnAnchor>): Record<string, TurnAnchor> => {
    const keys = Object.keys(anchors);
    if (keys.length <= MAX_ANCHORS_PER_CONVERSATION) {
        return anchors;
    }
    const kept = keys
        .map(Number)
        .toSorted((a, b) => a - b)
        .slice(-MAX_ANCHORS_PER_CONVERSATION);
    return Object.fromEntries(kept.map((index) => [String(index), anchors[String(index)] as TurnAnchor]));
};

// Same anchor by value; a turn re-run at the same index on a clean tree is the common repeat, letting the write be
// skipped.
const same = (a: TurnAnchor | undefined, b: TurnAnchor): boolean => {
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

export const fileTurnAnchors = (path: string): TurnAnchors => {
    const file = jsonFile<AnchorsFile>(path, {
        parse: (raw) => FileSchema.safeParse(raw).data,
        fallback: () => ({}),
    });

    return {
        record: async (conversationId, index, anchor) => {
            await file.update((current) => {
                const existing = current[conversationId];
                if (same(existing?.[String(index)], anchor)) {
                    // Unchanged by reference ⇒ jsonFile skips the write.
                    return current;
                }
                const anchors = trimmed({ ...existing, [String(index)]: anchor });
                // Re-inserted last so key order is recency order; eviction below is then a plain slice, no timestamp
                // needed.
                const { [conversationId]: _moved, ...rest } = current;
                const next = { ...rest, [conversationId]: anchors };
                const ids = Object.keys(next);
                return ids.length <= MAX_CONVERSATIONS
                    ? next
                    : Object.fromEntries(ids.slice(-MAX_CONVERSATIONS).map((id) => [id, next[id] as Record<string, TurnAnchor>]));
            });
        },
        of: async (conversationId, index) => (await file.read())[conversationId]?.[String(index)],
        all: async (conversationId) =>
            new Map(Object.entries((await file.read())[conversationId] ?? {}).map(([index, anchor]) => [Number(index), anchor])),
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
