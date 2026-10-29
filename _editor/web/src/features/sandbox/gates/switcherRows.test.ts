import { answerNote, removalTakes } from "./switcherRows";

// A user removed a sandbox without being told its connected accounts went with it.

describe(`removalTakes`, () => {
    it(`lists what an owner's removal takes along`, () => {
        expect(removalTakes(`owner`)).toEqual([
            { icon: `key`, label: `Connected accounts`, note: `ChatGPT, Claude, GitHub` },
            { icon: `cog`, label: `Settings`, note: `Instructions, capabilities` },
            { icon: `comments`, label: `Chats and files`, note: `The whole workspace` },
        ]);
    });

    it(`lists nothing for a member leaving, who takes nothing with them`, () => {
        expect(removalTakes(`collaborator`)).toEqual([]);
    });
});

// A hosted box asleep read as "not answering" in warning ink, as if it were broken, when picking it wakes it; a box its
// own computer put to sleep did the same until 2026-10-29, since only a hosted machine's state was read.
describe(`answerNote`, () => {
    it(`says asleep without a warning, and which computer is off when nothing can start it`, () => {
        expect(answerNote(`asleep`)).toEqual({ text: `asleep: opens when you select it` });
        expect(answerNote(`unwakeable`, `omen`)).toEqual({ text: `asleep: omen offline` });
        expect(answerNote(`unwakeable`)).toEqual({ text: `asleep: computer offline` });
    });

    it(`warns only for a box that should answer and does not`, () => {
        expect(answerNote(`starting`)).toEqual({ text: `starting: ready in a moment` });
        expect(answerNote(`not-answering`)).toEqual({ text: `not answering`, ink: `text-warning` });
    });

    it(`says nothing for a box that answers, or one not read yet`, () => {
        expect([answerNote(`answering`), answerNote(`unknown`)]).toEqual([undefined, undefined]);
    });
});
