import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// What a removal takes with it is about words rather than wiring. Pure, so it is pinned by a test instead of by
// reading a template.

// WHAT LEAVES WITH A REMOVED SANDBOX. Everything the reader set up lives inside the sandbox, not on the account, so a
// removal takes it along; the dialog used to say only that the box keeps running. A member leaving takes nothing. Each is
// a mark, a name and a few words of example, drawn as a tile: three short tiles are read where three sentences were not.
export interface RemovalTake {
    readonly icon: IconName;
    readonly label: string;
    readonly note: string;
}

export const removalTakes = (role: string): readonly RemovalTake[] =>
    role === `owner`
        ? [
              { icon: `key`, label: t(`sandbox.removeAsk.accounts`), note: t(`sandbox.removeAsk.accountsNote`) },
              { icon: `cog`, label: t(`sandbox.removeAsk.settings`), note: t(`sandbox.removeAsk.settingsNote`) },
              { icon: `comments`, label: t(`sandbox.removeAsk.chats`), note: t(`sandbox.removeAsk.chatsNote`) },
          ]
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
