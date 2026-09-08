import { describe, expect, it } from "vitest";
import { holdsCard } from "@intentic/sandbox-contract";
import { type ChatMessage, liveBubbleOf, recordedRows, repeatedChecklistIds } from "./transcript";

const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];

it(`keeps checklist changes and meaningful intervening messages while hiding only unchanged retry copies`, () => {
    const todos = [{ content: `Build`, status: `pending` as const }];
    const messages: ChatMessage[] = [
        { id: 1, role: `assistant`, text: ``, todos },
        { id: 2, role: `notice`, text: `Usage limit reached` },
        { id: 3, role: `assistant`, text: ``, todos: [...todos] },
        { id: 4, role: `assistant`, text: ``, todos: [{ content: `Build`, status: `completed` }] },
        { id: 5, role: `user`, text: `Try again` },
        { id: 6, role: `assistant`, text: ``, todos },
        { id: 7, role: `assistant`, text: `Working`, todos },
        { id: 8, role: `assistant`, text: ``, todos, question: { requestId: `q1`, questions, status: `pending` } },
    ];
    expect(repeatedChecklistIds(messages)).toEqual(new Set([3]));
    expect(recordedRows(messages)).toBe(8);
});

describe(`recordedRows`, () => {
    // Must match the daemon's own fold: a bubble holding only a card counts, an empty bubble never does, and a notice
    // counts unless this window drew it itself.
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
    it(`finds no bubble while the turn has produced nothing`, () => {
        expect(liveBubbleOf([{ id: 1, role: `user`, text: `go` }])).toBeUndefined();
    });

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

    it(`steps over a notice drawn under the live bubble`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `go` },
            { id: 2, role: `assistant`, text: `working` },
            { id: 3, role: `notice`, text: `Switched to Codex.`, local: true },
        ];
        expect(liveBubbleOf(messages)?.id).toBe(2);
    });

    it(`treats a mid-turn steer as leaving the turn without a bubble`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `go` },
            { id: 2, role: `assistant`, text: `working` },
            { id: 3, role: `user`, text: `actually, do it this way` },
        ];
        expect(liveBubbleOf(messages)).toBeUndefined();
    });
});
