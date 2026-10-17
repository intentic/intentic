import { answerNote, removalTakes } from "./switcherRows";

// A user removed a sandbox without being told its connected accounts went with it.

describe(`removalTakes`, () => {
    it(`lists what an owner's removal takes along`, () => {
        expect(removalTakes(`owner`)).toEqual([
            `The accounts connected to it, such as ChatGPT, Claude or GitHub`,
            `Its settings, agent instructions and capabilities`,
            `Its chats and its files`,
        ]);
    });

    it(`lists nothing for a member leaving, who takes nothing with them`, () => {
        expect(removalTakes(`collaborator`)).toEqual([]);
    });
});

// A hosted box asleep read as "not answering" in warning ink, as if it were broken, when picking it wakes it.
describe(`answerNote`, () => {
    it(`says asleep without a warning, answered or not`, () => {
        expect([answerNote(`asleep`, true), answerNote(`asleep`, false)]).toEqual([{ text: `asleep: opens when you select it` }, { text: `asleep: opens when you select it` }]);
    });

    it(`warns only for a silent box that is not booting`, () => {
        expect(answerNote(`starting`, true)).toEqual({ text: `starting: ready in a moment` });
        expect([answerNote(`awake`, true), answerNote(undefined, true)]).toEqual([
            { text: `not answering`, ink: `text-warning` },
            { text: `not answering`, ink: `text-warning` },
        ]);
    });

    it(`says nothing for a box that answers`, () => {
        expect([answerNote(`starting`, false), answerNote(`awake`, false), answerNote(undefined, false)]).toEqual([undefined, undefined, undefined]);
    });
});
