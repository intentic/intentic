import { addChoices, removalTakes } from "./switcherRows";

// A new user took "Add sandbox", the switcher's only add, for "add a project" and set a second sandbox up on the same
// computer; then removed one without being told its connected accounts went with it.

describe(`addChoices`, () => {
    it(`keeps the one "Add sandbox" row where the active sandbox does not run on this computer`, () => {
        expect(addChoices({ runsHere: false, projectsHome: true })).toEqual([{ to: `/setup`, label: `Add sandbox`, primary: true }]);
    });

    it(`offers a project first, and another sandbox second with the line that says how it differs, on this computer`, () => {
        expect(addChoices({ runsHere: true, projectsHome: true })).toEqual([
            { to: `/ext/projects`, label: `Add a project or folder`, primary: true },
            {
                to: `/setup`,
                label: `Add another sandbox`,
                note: `A separate machine, with its own files, accounts and chats.`,
                primary: false,
            },
        ]);
    });

    it(`sends the project row to the file tree where there is no Projects page`, () => {
        expect(addChoices({ runsHere: true, projectsHome: false })[0]?.to).toBe(`/workspace`);
    });
});

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
