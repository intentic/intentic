import { describe, expect, it } from "vitest";
import { holdsCard } from "@intentic/sandbox-contract";
import { type ChatMessage, liveBubbleOf, recordedRows } from "./transcript";

const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];

describe(`recordedRows`, () => {
    /* The count a fork copies a prefix of, and it has to agree with the daemon's own fold to the row. A card
     * closes the bubble it lands in and that bubble is a row, so a bubble holding nothing but a card counts; an
     * empty bubble never does (the fold drops it), and a notice counts unless this window drew it itself. */
    it(`counts a bubble holding nothing but a card, as the daemon's record does`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `choose` },
            { id: 2, role: `assistant`, text: ``, question: { requestId: `q1`, questions, status: `answered` } },
            { id: 3, role: `assistant`, text: `` },
            { id: 4, role: `notice`, text: `Switched to Codex.`, local: true },
            { id: 5, role: `notice`, text: `The provider refused the turn.` },
            { id: 6, role: `assistant`, text: ``, permission: { requestId: `perm1`, toolName: `Bash`, status: `cancelled` } },
        ];
        expect(messages.map(holdsCard)).toEqual([false, true, false, false, false, true]);
        expect(recordedRows(messages)).toBe(4);
    });
});

describe(`liveBubbleOf`, () => {
    // The state a conversation's first turn sits in for its whole opening: the words are sent, the daemon is
    // cutting a worktree and spawning a harness, and the model has not produced a frame. Nothing here is the
    // turn's bubble, which is what tells ChatPane to draw the status line itself.
    it(`finds no bubble while the turn has produced nothing`, () => {
        expect(liveBubbleOf([{ id: 1, role: `user`, text: `go` }])).toBeUndefined();
    });

    // The same opening on a LATER turn, and the case that made a finished answer wear a spinner: the newest
    // assistant row belongs to the turn ABOVE this prompt, so it is not the one being written into.
    it(`does not mistake the previous turn's answer for the live one`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `first` },
            { id: 2, role: `assistant`, text: `done` },
            { id: 3, role: `user`, text: `second` },
        ];
        expect(liveBubbleOf(messages)).toBeUndefined();
    });

    it(`is the bubble the turn is writing into once it has opened one`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `first` },
            { id: 2, role: `assistant`, text: `done` },
            { id: 3, role: `user`, text: `second` },
            { id: 4, role: `assistant`, text: `working` },
        ];
        expect(liveBubbleOf(messages)?.id).toBe(4);
    });

    // A notice this window wrote sits BELOW the bubble the turn is still writing into, so it is stepped over
    // rather than read as the end of the turn.
    it(`steps over a notice drawn under the live bubble`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `go` },
            { id: 2, role: `assistant`, text: `working` },
            { id: 3, role: `notice`, text: `Switched to Codex.`, local: true },
        ];
        expect(liveBubbleOf(messages)?.id).toBe(2);
    });

    // A steer lands as a user row under the answer it interrupts: what the agent says next is its reply to
    // THAT, so the turn is between bubbles again and the status line goes back to the foot of the column.
    it(`treats a mid-turn steer as leaving the turn without a bubble`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `go` },
            { id: 2, role: `assistant`, text: `working` },
            { id: 3, role: `user`, text: `actually, do it this way` },
        ];
        expect(liveBubbleOf(messages)).toBeUndefined();
    });
});
