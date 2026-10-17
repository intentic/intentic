import { t } from "@intentic/ui/i18n";

// What a removal takes with it is about words rather than wiring. Pure, so it is pinned by a test instead of by
// reading a template.

// WHAT LEAVES WITH A REMOVED SANDBOX. Everything the reader set up lives inside the sandbox, not on the account, so a
// removal takes it along; the dialog used to say only that the box keeps running. A member leaving takes nothing.
export const removalTakes = (role: string): readonly string[] =>
    role === `owner`
        ? [t(`sandbox.sandboxSwitcher.takesAccounts`), t(`sandbox.sandboxSwitcher.takesSettings`), t(`sandbox.sandboxSwitcher.takesChats`)]
        : [];

// WHETHER A ROW'S MACHINE ANSWERS, in words and ink. A hosted machine asleep wakes when it is picked and one booting is on
// its way, so neither earns the warning a silent box does; a box that answers says nothing.
export const answerNote = (hostedState: string | undefined, silent: boolean): { readonly text: string; readonly ink?: string } | undefined => {
    if (hostedState === `asleep`) {
        return { text: t(`sandbox.sandboxSwitcher.asleep`) };
    }
    if (!silent) {
        return undefined;
    }
    return hostedState === `starting` ? { text: t(`sandbox.sandboxSwitcher.starting`) } : { text: t(`sandbox.sandboxSwitcher.notAnswering`).toLocaleLowerCase(), ink: `text-warning` };
};
