import { t } from "@intentic/ui/i18n";

// The switcher's two decisions that are about words rather than wiring: what "add" offers, and what a removal takes
// with it. Pure, so both are pinned by a test instead of by reading a template.

export interface AddChoice {
    readonly to: string;
    readonly label: string;
    // The first, louder row; the other is the quieter alternative under it.
    readonly primary: boolean;
}

// WHAT "ADD" MEANS DEPENDS ON WHERE THE READER IS. With the active sandbox already running on this very computer, the
// likely want is more work inside it, a project or a folder, and a second container beside it is the rare case: a new
// user took "Add sandbox", the only add on offer, for "add a project" and set a second sandbox up on the same machine.
// Anywhere else the add stays what it was, one row.
export const addChoices = (input: { readonly runsHere: boolean; readonly projectsHome: boolean }): readonly AddChoice[] => {
    if (!input.runsHere) {
        return [{ to: `/setup`, label: t(`sandbox.words.addSandbox`), primary: true }];
    }
    return [
        // The Projects page makes a new project in a press; without it, the file tree is where a folder or a clone lands.
        { to: input.projectsHome ? `/ext/projects` : `/workspace`, label: t(`sandbox.sandboxSwitcher.addProjectOrFolder`), primary: true },
        {
            to: `/setup`,
            label: t(`sandbox.sandboxSwitcher.addAnotherSandbox`),
            primary: false,
        },
    ];
};

// WHAT LEAVES WITH A REMOVED SANDBOX. Everything the reader set up lives inside the sandbox, not on the account, so a
// removal takes it along; the dialog used to say only that the box keeps running. A member leaving takes nothing.
export const removalTakes = (role: string): readonly string[] =>
    role === `owner`
        ? [t(`sandbox.sandboxSwitcher.takesAccounts`), t(`sandbox.sandboxSwitcher.takesSettings`), t(`sandbox.sandboxSwitcher.takesChats`)]
        : [];
