import type { QueuedServing } from "@intentic/sandbox-contract/schemas/agent";
import type { ComposerDraft, DraftWritten } from "@intentic/sandbox-contract/schemas/composer-drafts";
import { basename } from "@intentic/ui/path";
import type { ForkLink, FreshLink } from "../run/turnRequest";

// THIS BROWSER'S COPY OF ONE UNSENT MESSAGE, and the rules it is kept against the sandbox's by. The sandbox holds the
// draft (schemas/composer-drafts.ts); this copy is what the composer edits at once, what survives a sandbox nobody can
// reach, and what an older sandbox with no drafts of its own is left with. Pure: composerDrafts.ts does the storage, the
// windows and the calls. The one rule above the rest: no edit is ever dropped unseen. A copy edited from a revision the
// sandbox has moved past keeps both sets of words; only words the person already sent, or saw cleared, go.

export interface DraftFile {
    readonly name: string;
    readonly path: string;
}

/** What the composer holds: the words and files, and who they are for when they open a conversation. */
export interface DraftWords {
    readonly text: string;
    readonly attachments: readonly DraftFile[];
    readonly serves?: QueuedServing | undefined;
    readonly forkOf?: ForkLink | undefined;
    readonly freshOf?: FreshLink | undefined;
}

/** The sandbox's copy this one last agreed with. */
export interface SyncedDraft {
    readonly revision: number;
    readonly text: string;
    readonly paths: readonly string[];
}

export interface HeldDraft extends DraftWords {
    readonly conversationId: string;
    // When the composer first held these words unsent.
    readonly since: number;
    // When a window of this browser last changed this copy, on this browser's clock: of two windows' copies, the later
    // one is the newer. Moves with an edit only, never with an answer from the sandbox.
    readonly editedAt: number;
    // Absent until the sandbox has held these words.
    readonly synced?: SyncedDraft | undefined;
    // Changed here since `synced`, waiting to be written. An empty pending copy is a clear on its way.
    readonly pending: boolean;
    // The sandbox the conversation lives in, when it is not the one this browser is pointed at: such a copy is kept here
    // and never written anywhere, since only the sandbox in view is read back.
    readonly box?: string | undefined;
}

const pathsOf = (words: Pick<DraftWords, "attachments">): readonly string[] => words.attachments.map((file) => file.path);

const samePaths = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((path, at) => path === right[at]);

/** Something to send: words beyond whitespace, or a file. */
export const holdsWords = (words: Pick<DraftWords, "text" | "attachments">): boolean => words.text.trim() !== `` || words.attachments.length > 0;

/** The same words and files, whoever they are for. */
export const sameWords = (left: Pick<DraftWords, "text" | "attachments">, right: Pick<SyncedDraft, "text" | "paths">): boolean =>
    left.text === right.text && samePaths(pathsOf(left), right.paths);

const syncedOf = (draft: ComposerDraft): SyncedDraft => ({ revision: draft.revision, text: draft.text, paths: draft.attachments ?? [] });

/** The sandbox's draft as this browser keeps it, its files named as this copy already named them where it can. */
const fromSandbox = (draft: ComposerDraft, previous: HeldDraft | undefined, now: number): HeldDraft => {
    const names = new Map((previous?.attachments ?? []).map((file) => [file.path, file.name] as const));
    return {
        conversationId: draft.conversationId,
        text: draft.text,
        attachments: (draft.attachments ?? []).map((path) => ({ path, name: names.get(path) ?? basename(path) })),
        serves: draft.serves,
        forkOf: draft.forkOf,
        freshOf: draft.freshOf,
        since: draft.since,
        editedAt: previous?.editedAt ?? now,
        synced: syncedOf(draft),
        pending: false,
    };
};

/**
 * Two sets of words for one message, kept both: theirs (the sandbox's, newer than what this copy was edited from) ahead
 * of mine. One already containing the other is just the longer, so a copy that only went on typing is not doubled.
 */
export const joinedWords = (theirs: DraftWords, mine: DraftWords): DraftWords => {
    const text = theirs.text.includes(mine.text) ? theirs.text : mine.text.includes(theirs.text) ? mine.text : `${theirs.text.trimEnd()}\n\n${mine.text.trimStart()}`;
    const seen = new Set(pathsOf(theirs));
    return {
        text,
        attachments: [...theirs.attachments, ...mine.attachments.filter((file) => !seen.has(file.path))],
        serves: mine.serves ?? theirs.serves,
        forkOf: mine.forkOf ?? theirs.forkOf,
        freshOf: mine.freshOf ?? theirs.freshOf,
    };
};

// Nothing typed here since this copy last agreed with the sandbox.
const unchangedHere = (draft: HeldDraft): boolean => draft.synced !== undefined && sameWords(draft, draft.synced);

// One draft the sandbox listed, against this copy of it: the sandbox's words wherever this copy holds no edit of its own
// and has not already agreed with something newer.
const listedNow = (draft: ComposerDraft, mine: HeldDraft | undefined, now: number): HeldDraft => {
    if (mine?.pending === true && mine.synced === undefined && holdsWords(mine) && !sameWords(mine, syncedOf(draft))) {
        // Words written here before this browser ever read the sandbox's (offline, or from an older sandbox), and other
        // words there: a write without a revision would put one over the other, so both are kept now.
        return { ...mine, ...joinedWords(fromSandbox(draft, mine, now), mine), synced: syncedOf(draft) };
    }
    const newer = mine?.synced === undefined || draft.revision >= mine.synced.revision;
    return mine !== undefined && (mine.pending || !newer) ? mine : fromSandbox(draft, mine, now);
};

// A copy the sandbox did not list: gone (sent, or cleared on another device) only when it was agreed at or before the
// read; one never held there, or written since, stays. Undefined: let it go.
const unlistedNow = (mine: HeldDraft, readAt: number | undefined): HeldDraft | undefined => {
    const goneThere = mine.synced !== undefined && readAt !== undefined && mine.synced.revision <= readAt;
    if (mine.box !== undefined || !goneThere) {
        // Never held there (written while the sandbox kept none, or before this browser first reached it): written next.
        return mine.box === undefined && mine.synced === undefined && holdsWords(mine) ? { ...mine, pending: true } : mine;
    }
    // Words typed here after the sandbox let the draft go: new words, written as a draft of their own.
    return mine.pending && !unchangedHere(mine) && holdsWords(mine) ? { ...mine, synced: undefined } : undefined;
};

/** This browser's drafts once the sandbox's list has been read: every edit made here kept for the next write. */
export const pulled = (
    local: ReadonlyMap<string, HeldDraft>,
    remote: { readonly drafts: readonly ComposerDraft[]; readonly revision?: number | undefined },
    now: number,
): Map<string, HeldDraft> => {
    const next = new Map(remote.drafts.map((draft) => [draft.conversationId, listedNow(draft, local.get(draft.conversationId), now)] as const));
    for (const [id, mine] of local) {
        const kept = next.has(id) ? undefined : unlistedNow(mine, remote.revision);
        if (kept !== undefined) {
            next.set(id, kept);
        }
    }
    return next;
};

/**
 * The copy after the sandbox answered a write or a clear of `sent` (the copy as it was when the call left), where
 * `current` is the copy now. Undefined: nothing is left to keep. Never loses an edit made while the call was out.
 */
export const answered = (current: HeldDraft, sent: HeldDraft, answer: DraftWritten): HeldDraft | undefined => {
    const editedSince = current.editedAt !== sent.editedAt;
    const theirs = answer.draft;
    if (answer.conflict === true) {
        if (theirs === undefined) {
            // Sent or cleared elsewhere since this copy's revision: only words typed after that agreement are kept.
            return holdsWords(current) && !unchangedHere(current) ? { ...current, synced: undefined, pending: true } : undefined;
        }
        if (sameWords(current, syncedOf(theirs)) || unchangedHere(current) || !holdsWords(current)) {
            // Nothing of this copy's own to keep: the same words, none typed here since, or a clear the newer words outlive.
            return fromSandbox(theirs, current, current.editedAt);
        }
        return { ...current, ...joinedWords(fromSandbox(theirs, current, current.editedAt), current), synced: syncedOf(theirs), pending: true };
    }
    if (theirs === undefined) {
        return editedSince && holdsWords(current) ? { ...current, synced: undefined, pending: true } : undefined;
    }
    return { ...current, synced: syncedOf(theirs), pending: editedSince, since: theirs.since };
};
