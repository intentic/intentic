import { z } from "zod";
import { jsonFile } from "../store/json-file.js";

/* WHAT EACH MESSAGE CAN GO BACK TO, the durable half of every "return to this point" affordance, and the one
 * place the two kinds of workspace a conversation can own are told apart.
 *
 * The daemon already picks a pre-turn state for every turn and ships it to the client, which is what "go back to
 * before this message" hangs on. That frame is the RIGHT state, as the agent found it, not as it left it, and
 * it is also gone the moment the tab reloads: the transcript comes back from the daemon's record, and a restored
 * message carries nothing of the kind. So the affordance was available for exactly as long as the browser that
 * watched the turn stayed open, which is the opposite of when it is wanted.
 *
 * TWO KINDS, because a conversation works in one of two places and they are not restorable by the same means:
 *   · `tree`     , a main-tree turn, whose before-state is a workspace history checkpoint (history/history.ts).
 *   · `worktree` , an isolated turn, which never touches those captures; its before-state is a commit per repo
 *                   on the conversation's own branch, taken at the top of the turn.
 * Both answer the same two questions, put this conversation's files back here, and start a fork on the files as
 * they were here, so both live in one store under one index, and the callers switch on `kind` rather than on
 * whether the conversation happens to be isolated. A reader that had to ask the registry which store to consult
 * would get it wrong for exactly the conversations that changed placement.
 *
 * WHY A MAP AND NOT THE COMMIT. The obvious alternative is to stamp the turn onto the state itself and read it
 * back out of `git log`. It does not work, and the reason is worth writing down: the turn-start state is USUALLY
 * NOT A NEW COMMIT. The fence capture is a no-op when the tree is clean, the common case by far, and the id
 * then refers to an EXISTING state, which may already belong to another turn and cannot be re-stamped after the
 * fact. A map keyed by (conversation, index) says the one thing that is true in both branches: this message's
 * before-state is that one. Several messages naming the same state is not a conflict, it is what a run of turns
 * that changed nothing looks like.
 *
 * On the HISTORY volume beside the transcripts and the journal: daemon-private, outside the agent's reach, and
 * surviving the container rebuilds that recreate everything under ~/. */

const AnchorSchema = z.union([
    z.object({ kind: z.literal("tree"), snapshot: z.string().min(1) }),
    z.object({ kind: z.literal("worktree"), repos: z.array(z.object({ repo: z.string(), base: z.string().min(1) })).min(1) }),
]);
export type TurnAnchor = z.infer<typeof AnchorSchema>;

// index → anchor, per conversation. Object-keyed rather than an array because the indices are sparse: a turn
// that could not be anchored at all (a history failure, a worktree that never came up) files nothing.
const FileSchema = z.record(z.string(), z.record(z.string(), AnchorSchema));
type AnchorsFile = z.infer<typeof FileSchema>;

/* Bound so one conversation cannot grow this without limit, and so the file stays a file. Oldest INDICES go
 * first, which is the right end: going back to the top of a thousand-turn conversation is not what any of this
 * is for, and the recent turns are the ones anyone reaches back into. */
const MAX_ANCHORS_PER_CONVERSATION = 200;
// Conversations, evicted by which was touched least recently, same shape of bound, one level up.
const MAX_CONVERSATIONS = 500;

export interface TurnAnchors {
    // Remember what this conversation's message `index` can be put back to.
    readonly record: (conversationId: string, index: number, anchor: TurnAnchor) => Promise<void>;
    // The anchor for one message, or undefined where it has none (a turn from before this file existed, a turn
    // whose state could not be captured, or a conversation that has been evicted).
    readonly of: (conversationId: string, index: number) => Promise<TurnAnchor | undefined>;
    // Every bound index for a conversation, for stamping a transcript being read back.
    readonly all: (conversationId: string) => Promise<ReadonlyMap<number, TurnAnchor>>;
    // Drop the anchors at or after `from`, what a rewind does to the messages it just dropped, so a second
    // rewind cannot offer to go back to a turn that no longer exists.
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

// Same anchor by value, a turn re-run at the same index against the same clean tree is the common repeat, and
// recognising it is what lets the write below be skipped.
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
                /* Re-inserted LAST so plain key order is recency order, which is what makes the eviction below
                 * a slice rather than a second timestamp per conversation to keep in step. */
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
