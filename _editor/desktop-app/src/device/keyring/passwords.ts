import { errorMessage } from "@intentic/base/errors";
import type { KeyringShareMode } from "@intentic/sandbox-contract";
import { computed, getCurrentScope, onScopeDispose, ref } from "vue";
import {
    type KeyringEntry,
    KeyringRefusal,
    type KeyringStatus,
    type NewKeyringEntry,
    keyringAdd,
    keyringAskpass,
    keyringHarden,
    keyringList,
    keyringLock,
    keyringRemove,
    keyringSetup,
    keyringShare,
    keyringStatus,
    keyringUnlock,
} from "../../desktop";

// THE PASSWORDS GROUP'S STATE (PasswordsGroup.vue): the keyring on this computer as `intentic-machine keyring` reports
// it, and every change to it. Each change makes the keyring ask the person at this computer (Windows Hello, or its
// passphrase), so one runs at a time and `waiting` names it while the prompt is up; the list is read again however it
// ended, since a change the person declined leaves the vault as it was.

/** The act a prompt on this computer is up for, while it is. */
export type PasswordsAct = `setup` | `add` | `remove` | `share` | `unlock` | `lock` | `askpass` | `harden`;

/** A new entry, its value, and the sandbox it goes to straight away, if any. */
export interface PasswordDraft {
    readonly entry: NewKeyringEntry;
    readonly value: string;
    readonly share?: { readonly sandbox: string; readonly mode: KeyringShareMode } | undefined;
}

export function usePasswords() {
    const status = ref<KeyringStatus | undefined>(undefined);
    // No machine agent at all: the group is not drawn, as This device draws no agent then either.
    const noAgent = ref(false);
    const entries = ref<readonly KeyringEntry[]>([]);
    const reading = ref(true);
    // The agent predates its keyring: the sentence it is answered with, and nothing else to offer.
    const tooOld = ref<string | undefined>(undefined);
    const readError = ref<string | undefined>(undefined);
    const waiting = ref<PasswordsAct | undefined>(undefined);
    const error = ref<string | undefined>(undefined);

    // An unlock ends by itself at its time: read again then, so the group does not go on saying "Unlocked".
    let relock: ReturnType<typeof setTimeout> | undefined;
    const followUnlock = (until: number | undefined): void => {
        clearTimeout(relock);
        relock = until === undefined ? undefined : setTimeout(() => void load(), Math.max(0, until - Date.now()) + 1000);
    };
    if (getCurrentScope() !== undefined) {
        onScopeDispose(() => clearTimeout(relock));
    }

    const load = async (): Promise<void> => {
        try {
            const read = await keyringStatus();
            followUnlock(read?.state?.locked === false ? read.state.unlockedUntil : undefined);
            noAgent.value = read === undefined;
            status.value = read;
            tooOld.value = undefined;
            readError.value = undefined;
            entries.value = read?.setUp === true ? await keyringList() : [];
        } catch (failure) {
            if (failure instanceof KeyringRefusal && failure.code === `agent-too-old`) {
                tooOld.value = failure.message;
            } else {
                readError.value = errorMessage(failure);
            }
        } finally {
            reading.value = false;
        }
    };

    // One change at a time: each is a prompt on this computer, and two at once would be two prompts nobody can tell apart.
    const run = async (act: PasswordsAct, task: () => Promise<void>): Promise<boolean> => {
        if (waiting.value !== undefined) {
            return false;
        }
        waiting.value = act;
        error.value = undefined;
        try {
            await task();
            return true;
        } catch (failure) {
            error.value = errorMessage(failure);
            return false;
        } finally {
            waiting.value = undefined;
            await load();
        }
    };

    return {
        status,
        noAgent,
        entries,
        reading,
        tooOld,
        readError,
        waiting,
        error,
        setUp: computed(() => status.value?.setUp === true),
        locked: computed(() => status.value?.state?.locked !== false),
        load,
        setup: (passphrase: string, hello: boolean): Promise<boolean> => run(`setup`, () => keyringSetup(passphrase, hello)),
        // Added, then shared if asked: two prompts, said as one act. A share that is refused leaves the entry added, which
        // the list then shows unshared, and the refusal says why.
        add: (draft: PasswordDraft): Promise<boolean> =>
            run(`add`, async () => {
                await keyringAdd(draft.entry, draft.value);
                if (draft.share !== undefined) {
                    await keyringShare(draft.entry.name, draft.share.sandbox, draft.share.mode);
                }
            }),
        remove: (name: string): Promise<boolean> => run(`remove`, () => keyringRemove(name)),
        share: (name: string, sandbox: string, mode: KeyringShareMode): Promise<boolean> => run(`share`, () => keyringShare(name, sandbox, mode)),
        unlock: (minutes?: number): Promise<boolean> => run(`unlock`, () => keyringUnlock(minutes)),
        lock: (): Promise<boolean> => run(`lock`, () => keyringLock()),
        askpass: (on: boolean): Promise<boolean> => run(`askpass`, () => keyringAskpass(on ? `install` : `uninstall`)),
        harden: (): Promise<boolean> => run(`harden`, () => keyringHarden()),
        dismissError: (): void => {
            error.value = undefined;
        },
    };
}
