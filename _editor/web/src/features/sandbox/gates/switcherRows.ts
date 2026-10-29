import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { SandboxAnswer } from "../../../client/sandbox/wake/sandboxAnswer";

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

// WHETHER A ROW'S MACHINE ANSWERS, in words and ink (client/sandbox/wake/sandboxAnswer.ts). A sandbox asleep wakes when it is
// picked and one booting is on its way, so neither earns the warning a silent box does; one asleep on a computer that is
// off says which computer, since that is what the reader has to go and wake; a box that answers says nothing. Asleep
// was read off a hosted machine only until 2026-10-29, so a sandbox its own computer had put to sleep was "not answering"
// in warning ink.
export const answerNote = (answer: SandboxAnswer, machine?: string): { readonly text: string; readonly ink?: string } | undefined => {
    switch (answer) {
        case `asleep`:
            return { text: t(`sandbox.sandboxSwitcher.asleep`) };
        case `unwakeable`:
            return { text: machine === undefined ? t(`sandbox.sandboxSwitcher.asleepComputerOff`) : t(`sandbox.sandboxSwitcher.asleepMachineOff`, { machine }) };
        case `starting`:
            return { text: t(`sandbox.sandboxSwitcher.starting`) };
        case `not-answering`:
            return { text: t(`sandbox.sandboxSwitcher.notAnswering`).toLocaleLowerCase(), ink: `text-warning` };
        case `answering`:
        case `unknown`:
            return undefined;
    }
};
