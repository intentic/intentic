import type { AgentReaction } from "@intentic/sandbox-contract/schemas/agents";
import type { ComposerDraft, ComposerDrafts, DraftClear, DraftReactions, DraftWrite, DraftWritten } from "@intentic/sandbox-contract/schemas/composer-drafts";
import type { SandboxHandlerInput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { refuse } from "@intentic/contract-serve";
import { busyDrafts } from "../../fixture/fleet";
import { demoMode } from "../../mode";
import { reactToAgent } from "./cards";
import { OWNER, roster } from "./roster";

// The demo's stand-in for the daemon's composer drafts (conversations/drafts/composer-drafts.ts), held for this page's
// life: one person, the same revision rules, so a composer in the demo writes, conflicts and clears as against a sandbox.

const drafts = new Map<string, ComposerDraft>();
let revision = 0;
// The reader's marks on conversations no turn has started yet, kept apart from the words as the daemon keeps them.
const marks = new Map<string, AgentReaction[]>();

// The busy recording opens holding two drafts, so its Active lane has its Drafts group.
if (demoMode.id === `busy`) {
    for (const draft of busyDrafts(Date.now())) {
        revision += 1;
        drafts.set(draft.id, { conversationId: draft.id, text: draft.text, since: draft.since, revision });
    }
}

const answerOf = (draft: ComposerDraft | undefined, conflict: boolean): DraftWritten => {
    const answer: DraftWritten = draft === undefined ? {} : { draft };
    return conflict ? { ...answer, conflict: true } : answer;
};

const listDrafts = (): ComposerDrafts => ({
    drafts: [...drafts.values()].toSorted((a, b) => b.revision - a.revision),
    revision,
    reactions: Object.fromEntries(marks),
});

// As the daemon's `agents.reactDraft`: refused for a conversation on the board, which `react` marks.
const reactDraft = ({ id, emoji, on }: SandboxHandlerInput<`agents`, `reactDraft`>): DraftReactions => {
    if (roster.agents.some((agent) => agent.id === id)) {
        return refuse(`This conversation has started: mark its card instead.`, 409);
    }
    const held = marks.get(id) ?? [];
    // A press already where it asks moves nothing, its chip's place included.
    if (held.some((chip) => chip.emoji === emoji) === on) {
        return { reactions: held };
    }
    const others = held.filter((chip) => chip.emoji !== emoji);
    const me: AgentReaction[`by`][number] = { email: OWNER.email, at: Date.now() };
    if (OWNER.name !== undefined) {
        me.name = OWNER.name;
    }
    const next = on ? [...others, { emoji, by: [me] }] : others;
    if (next.length === 0) {
        marks.delete(id);
    } else {
        marks.set(id, next);
    }
    return { reactions: next };
};

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
    <I extends { readonly conversationId?: string; readonly draft?: number }, R extends unknown[], A>(run: (input: I, ...rest: R) => A) =>
    (input: I, ...rest: R): A => {
        const answer = run(input, ...rest);
        const id = input.conversationId ?? ``;
        clearSentDraft(id, input.draft);
        // The marks left on it while it was a draft go onto its card, as the daemon moves them with the first turn.
        if (roster.agents.some((agent) => agent.id === id)) {
            for (const chip of marks.get(id) ?? []) {
                reactToAgent({ id, emoji: chip.emoji, on: true });
            }
            marks.delete(id);
        }
        return answer;
    };

// The drafts routes, as the daemon's agents router answers them.
export const draftDoors = { drafts: listDrafts, writeDraft, clearDraft, reactDraft };
