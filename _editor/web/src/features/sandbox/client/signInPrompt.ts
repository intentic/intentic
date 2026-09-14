import type { DaemonSession } from "@intentic/sandbox-contract";
import { shallowRef } from "vue";
import type { SandboxTarget } from "./sandboxTarget";

// The one sign-in question the gate can be asked, and the answer the session module waits for. Its own module, with
// nothing heavy behind it, so the gate and its tests can read the state without loading Google's script or storage.

export type SignInPrompt =
    // No proof in hand: Google's button is up (useGoogleIdentity raises it), and a passkey is offered beside it when
    // the daemon says one is registered for this origin.
    | { readonly kind: `choose`; readonly target: SandboxTarget; readonly passkey: boolean }
    // A Google proof was accepted but this sandbox requires a passkey: confirm with the one held, or add a first one
    // under `bearer`; the owner may also spend a recovery code.
    | { readonly kind: `step-up`; readonly target: SandboxTarget; readonly enrolled: boolean; readonly bearer: string };

// Shallow: the prompt is replaced whole, and its target must stay the very object the session module raised it
// with, so the offer that lands later can tell it is for the same sign-in.
const prompt = shallowRef<SignInPrompt | undefined>(undefined);

// Settles the establish that raised the prompt: a session it may store, or undefined for a dismissal.
let settle: ((session: DaemonSession | undefined) => void) | undefined;

// Raised by the session module; resolves when the gate settles it. Raising over a standing prompt settles the old one
// with nothing, since a second establish means the first's reason went away.
export const raiseSignIn = (next: SignInPrompt): Promise<DaemonSession | undefined> => {
    settle?.(undefined);
    prompt.value = next;
    return new Promise((resolve) => {
        settle = (session) => {
            settle = undefined;
            prompt.value = undefined;
            resolve(session);
        };
    });
};

// Called by the gate when a ceremony minted a session; a no-op when nothing is waiting.
export const completeSignIn = (session: DaemonSession): void => settle?.(session);

export const dismissSignIn = (): void => settle?.(undefined);

// Lets the passkey offer land after the prompt went up, without disturbing a prompt that moved on.
export const offerPasskey = (target: SandboxTarget, offered: boolean): void => {
    if (prompt.value?.kind === `choose` && prompt.value.target === target) {
        prompt.value = { ...prompt.value, passkey: offered };
    }
};

export function useSignInPrompt() {
    return { prompt, completeSignIn, dismissSignIn };
}
