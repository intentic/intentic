import { describe, expect, it } from "vitest";
import { type ChatMessage, holdsCard, recordedRows } from "./transcript";

const questions = [{ question: `Which?`, header: `Pick`, multiSelect: false, options: [{ label: `A`, description: `a` }] }];

describe(`recordedRows`, () => {
    /* The count a fork copies a prefix of, and it has to agree with the daemon's own fold to the row. A card
     * opens its own bubble live (turnReducer) and the record writes that bubble down as a row, so a bubble
     * holding nothing but a card counts; an empty bubble never does, and a notice only when the record wrote it. */
    it(`counts a bubble holding nothing but a card, as the daemon's record does`, () => {
        const messages: ChatMessage[] = [
            { id: 1, role: `user`, text: `choose` },
            { id: 2, role: `assistant`, text: ``, question: { requestId: `q1`, questions, status: `answered` } },
            { id: 3, role: `assistant`, text: `` },
            { id: 4, role: `notice`, text: `Stopped.` },
            { id: 5, role: `notice`, text: `The provider refused the turn.`, recorded: true },
            { id: 6, role: `assistant`, text: ``, permission: { requestId: `perm1`, toolName: `Bash`, status: `cancelled` } },
        ];
        expect(messages.map(holdsCard)).toEqual([false, true, false, false, false, true]);
        expect(recordedRows(messages)).toBe(4);
    });
});
