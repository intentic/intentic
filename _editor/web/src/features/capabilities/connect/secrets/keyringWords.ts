import type { KeyringShareMode } from "@intentic/sandbox-contract/schemas/keyring";
import type { SandboxKeyring } from "@intentic/sandbox-contract/schemas/secrets";
import { t } from "@intentic/ui/i18n";

// The words a secret kept on one of the owner's computers is said in, wherever it is drawn: its row, the need card that
// keeps one there, the keyrings panel. One spelling of each share mode, so the card that chose it and the row that shows
// it cannot drift apart.

/** A share mode as a person says it: when the sandbox gets the value. */
export const keyringModeWords = (mode: KeyringShareMode): string => {
    switch (mode) {
        case `each-use`:
            return t(`capabilities.keyring.modeEachUse`);
        case `while-here`:
            return t(`capabilities.keyring.modeWhileHere`);
        case `copy`:
            return t(`capabilities.keyring.modeCopy`);
    }
};

/** What a share mode means in practice, one sentence, for the moment it is chosen. */
export const keyringModeExplained = (mode: KeyringShareMode, machine: string): string => {
    switch (mode) {
        case `each-use`:
            return t(`capabilities.keyring.modeEachUseExplained`, { machine });
        case `while-here`:
            return t(`capabilities.keyring.modeWhileHereExplained`, { machine });
        case `copy`:
            return t(`capabilities.keyring.modeCopyExplained`, { machine });
    }
};

/** The command that changes a keyring entry, typed on the computer that holds it: nothing here can change it. */
export const keyringEditCommand = (name: string): string => `intentic-machine keyring edit ${name}`;

/** A keyring's standing as a short phrase: offline, locked or unlocked. */
export const keyringStanding = (keyring: Pick<SandboxKeyring, `online` | `locked`>): string => {
    if (!keyring.online) {
        return t(`capabilities.keyring.offline`);
    }
    return keyring.locked === true ? t(`capabilities.keyring.locked`) : t(`capabilities.keyring.unlocked`);
};
