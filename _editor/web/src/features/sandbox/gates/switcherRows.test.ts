import { removalTakes } from "./switcherRows";

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
