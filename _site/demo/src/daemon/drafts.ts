import type { ComposerDraft, ComposerDrafts, DraftClear, DraftWrite, DraftWritten } from "@intentic/sandbox-contract/schemas/composer-drafts";

// The demo's stand-in for the daemon's composer drafts (conversations/drafts/composer-drafts.ts), held for this page's
// life: one person, the same revision rules, so a composer in the demo writes, conflicts and clears as against a sandbox.

const drafts = new Map<string, ComposerDraft>();
let revision = 0;

const answerOf = (draft: ComposerDraft | undefined, conflict: boolean): DraftWritten => {
    const answer: DraftWritten = draft === undefined ? {} : { draft };
    return conflict ? { ...answer, conflict: true } : answer;
};

const listDrafts = (): ComposerDrafts => ({
    drafts: [...drafts.values()].toSorted((a, b) => b.revision - a.revision),
    revision,
});

const clearDraft = ({ id, revision: only }: DraftClear): DraftWritten => {
    const current = drafts.get(id);
    if (current !== undefined && only !== undefined && current.revision !== only) {
        return answerOf(current, true);
    }
    drafts.delete(id);
    return {};
};

const writeDraft = (write: DraftWrite): DraftWritten => {
    const current = drafts.get(write.id);
    if (write.base !== undefined && current?.revision !== write.base) {
        return answerOf(current, true);
    }
    if (write.text.trim() === `` && (write.attachments?.length ?? 0) === 0) {
        return clearDraft({ id: write.id, revision: write.base });
    }
    revision += 1;
    const { id, base: _base, since, ...words } = write;
    const draft: ComposerDraft = { ...words, conversationId: id, since: current?.since ?? since ?? Date.now(), revision };
    drafts.set(id, draft);
    return { draft };
};

/** The draft a sent message was written from goes with it, as the daemon's `agent.run` clears it. */
const clearSentDraft = (conversationId: string, sentFrom: number | undefined): void => {
    if (sentFrom !== undefined) {
        clearDraft({ id: conversationId, revision: sentFrom });
    }
};

/** A send that takes its draft with it, as the daemon's `agent.run` does. */
export const clearingSentDraft =
    <I extends { readonly conversationId?: string; readonly draft?: number }, A>(run: (input: I) => A) =>
    (input: I): A => {
        const answer = run(input);
        clearSentDraft(input.conversationId ?? ``, input.draft);
        return answer;
    };

// The drafts routes, as the daemon's agents router answers them.
export const draftDoors = { drafts: listDrafts, writeDraft, clearDraft };
