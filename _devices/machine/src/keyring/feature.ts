import { existsSync } from "node:fs";
import { askKeyring, keyringPaths } from "@intentic/keyring";
import { keyringPath } from "../release.js";

// WHETHER THIS MACHINE OFFERS ITS KEYRING to the sandboxes it is linked to: the `keyring` feature of describe's facts.
// Only while the keyring binary is installed beside this agent and its pipe answers, so a sandbox never offers a computer
// without one as a place to keep or type a secret. Asked on every describe, which answers each connect and every card
// refresh, so the answer is kept for a while: a keyring that just started is offered within half a minute.

// How long the keyring may take to say its state before it counts as not answering: describe must stay quick.
export const KEYRING_PROBE_TIMEOUT_MS = 1_500;
// How long one answer is believed.
export const KEYRING_PROBE_TTL_MS = 30_000;

export interface KeyringProbeDeps {
    readonly installed: () => boolean;
    // Whether the pipe answered `state` at all: a refusal is an answer, silence or a dead pipe is not.
    readonly answers: () => Promise<boolean>;
    readonly now: () => number;
}

const realDeps: KeyringProbeDeps = {
    installed: () => existsSync(keyringPath),
    answers: async () =>
        await askKeyring({ address: keyringPaths().address, timeoutMs: KEYRING_PROBE_TIMEOUT_MS }, { op: "state" }).then(
            () => true,
            // allow(silent-catch): a keyring that does not answer is exactly what this asks about; the feature stays off
            () => false,
        ),
    now: Date.now,
};

// A probe with its own cache. Two describes at once share one ask rather than racing two connections to the pipe.
export const keyringProbe = (deps: KeyringProbeDeps = realDeps, ttlMs: number = KEYRING_PROBE_TTL_MS): (() => Promise<boolean>) => {
    let known: { readonly at: number; readonly answer: boolean } | undefined;
    let asking: Promise<boolean> | undefined;
    const ask = async (): Promise<boolean> => {
        if (!deps.installed()) {
            return false;
        }
        return await deps.answers();
    };
    return async () => {
        if (known !== undefined && deps.now() - known.at < ttlMs) {
            return known.answer;
        }
        asking ??= ask()
            .then((answer) => {
                known = { at: deps.now(), answer };
                return answer;
            })
            .finally(() => {
                asking = undefined;
            });
        return await asking;
    };
};

// This process's one probe, for describe.
export const keyringAdvertised = keyringProbe();
