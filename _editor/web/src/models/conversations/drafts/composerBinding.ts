import { effectScope, watch } from "vue";
import type { Conversation } from "../session/conversation";
import { chipOf } from "../session/queueCalls";
import type { StoredTab } from "../tabs/tabSnapshot";
import { draftOf, writeDraft } from "./composerDrafts";
import { type DraftWords, type HeldDraft, holdsWords, sameWords, type SyncedDraft } from "./heldDraft";

// A chat's composer, bound to its conversation's draft (composerDrafts.ts): what is typed is the draft, and a draft
// written in another window or on another device is what the composer shows. The composer keeps only what a draft
// cannot hold: a file still uploading, and the caret.

/** What a composer holds, as the draft it is: its words, its finished files, and who they are for. */
const composerWords = (conversation: Conversation): DraftWords => ({
    text: conversation.draft.value,
    attachments: conversation.attachments.value.filter((file) => file.status === `done`).map((file) => ({ name: file.name, path: file.path })),
    serves: {
        agent: conversation.selection.provider.value,
        harness: conversation.selection.harness.value,
        model: conversation.selection.model.value,
        effort: conversation.selection.effortPick.value,
        account: conversation.selection.account.value,
    },
    forkOf: conversation.pendingForkOf.value,
    freshOf: conversation.pendingFreshOf.value,
});

const composerHolds = (conversation: Conversation): Pick<SyncedDraft, "text" | "paths"> => {
    const words = composerWords(conversation);
    return { text: words.text, paths: words.attachments.map((file) => file.path) };
};

// The draft's words into the composer, leaving a file still uploading where it is. A conversation nothing has opened yet
// takes where it was cut from too, the one thing about it only the draft remembers.
const showDraft = (conversation: Conversation, draft: HeldDraft): void => {
    if (!sameWords(draft, composerHolds(conversation))) {
        conversation.draft.value = draft.text;
        conversation.attachments.value = [...draft.attachments.map(chipOf), ...conversation.attachments.value.filter((file) => file.status !== `done`)];
    }
    conversation.draftAt.value = draft.since;
    if (!conversation.registered.value) {
        conversation.pendingForkOf.value ??= draft.forkOf;
        conversation.pendingFreshOf.value ??= draft.freshOf;
    }
};

// What the sandbox let go of (sent from another window or device, or discarded with its conversation) leaves the
// composer too.
const clearComposer = (conversation: Conversation): void => {
    conversation.draft.value = ``;
    conversation.attachments.value = conversation.attachments.value.filter((file) => file.status !== `done`);
};

/**
 * Puts a conversation's draft in its composer, for a chat opened by a restore or a reveal before anything reads it. A
 * stored tab from before drafts were the sandbox's carries its own words, taken in here once when no draft is held.
 */
export const seedComposer = (conversation: Conversation, legacy?: Pick<StoredTab, "draft" | "draftAt" | "attachments">): void => {
    const id = conversation.conversationId;
    const carried = { text: legacy?.draft ?? ``, attachments: legacy?.attachments ?? [] };
    if (draftOf(id) === undefined && holdsWords(carried)) {
        writeDraft(id, { ...composerWords(conversation), ...carried }, { since: legacy?.draftAt, box: conversation.box.value });
    }
    const draft = draftOf(id);
    if (draft !== undefined) {
        showDraft(conversation, draft);
    }
};

/** Keeps one open chat's composer and its draft the same until the chat closes; returns what unbinds it. */
export const bindComposer = (conversation: Conversation): (() => void) => {
    const scope = effectScope(true);
    const id = conversation.conversationId;
    // Set while words written elsewhere are put in the composer: showing them is no edit made here, and writing them
    // back would make this window a second writer of a draft another window is typing (composerDrafts.ts `editedHere`).
    let showing = false;
    const shown = (show: () => void): void => {
        showing = true;
        try {
            show();
        } finally {
            showing = false;
        }
    };
    scope.run(() => {
        seedComposer(conversation);
        // Typed here: the draft, in the same tick, so a chat closed right after a programmatic write (a take-back, a
        // suggestion) cannot leave before its words are kept. Also the words a composer held before it was bound, when
        // they are not simply the draft it was just seeded with.
        watch(
            () => composerWords(conversation),
            (words, before) => {
                const seeded = before === undefined && sameWords(draftOf(id) ?? { text: ``, attachments: [] }, composerHolds(conversation));
                if (!showing && !seeded) {
                    writeDraft(id, words, { since: conversation.draftAt.value, box: conversation.box.value });
                }
            },
            { immediate: true, flush: `sync` },
        );
        // Written elsewhere: the composer.
        watch(
            () => draftOf(id),
            (draft, before) => {
                if (draft !== undefined) {
                    shown(() => showDraft(conversation, draft));
                } else if (before !== undefined && sameWords(before, composerHolds(conversation))) {
                    shown(() => clearComposer(conversation));
                }
            },
        );
    });
    return () => scope.stop();
};
