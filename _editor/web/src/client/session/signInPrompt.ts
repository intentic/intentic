import type { DaemonSession, PasskeyRequired } from "@intentic/sandbox-contract/schemas/system";
import { shallowRef } from "vue";
import type { SandboxTarget } from "../sandbox/sandboxTarget";

// The one sign-in question the gate can be asked, and the answer the session module waits for. Its own module, with
// nothing heavy behind it, so the gate and its tests can read the state without loading Google's script or storage.

// The proof each call of a passkey step-up is carried out under, asked for per call: a Google ID token or an owner
// ticket answers the same one every time, while an email account mints a fresh identity assertion for each call, since
// a daemon spends each assertion once.
export type StepUpBearer = () => Promise<string>;

// A proof good for every call of the ceremony, as a step-up bearer.
export const sameBearer =
    (proof: string): StepUpBearer =>
    () =>
        Promise.resolve(proof);

// What spending the platform's identity assertion came to: a session, or the passkey step-up the sandbox's rule asks for
// next (with a way to mint the fresh assertions a first passkey is enrolled under).
export type EmailAnswer = { readonly session: DaemonSession } | { readonly stepUp: PasskeyRequired; readonly bearer: StepUpBearer };

// The account's road by email on this sandbox, as the session module found it (sandboxSession.ts).
export type EmailRoad =
    // The daemon takes the platform's assertion: "Continue as" spends a fresh one. `refusal` is what the last one met:
    // the person is not opted in here (only the owner can change that), or the daemon has not learned the platform's
    // key yet (worth another try in a minute).
    | {
          readonly kind: `offered`;
          readonly address: string;
          readonly spend: () => Promise<EmailAnswer>;
          readonly refusal?: `email-sign-in-off` | `platform-key-unknown`;
      }
    // A daemon from before email sign-in: a gap said by name (app-plane.md: never an older path taken silently).
    | { readonly kind: `outdated`; readonly address: string };

export type SignInPrompt =
    // No proof in hand: Google's button is up (useGoogleIdentity raises it), and a passkey is offered beside it when
    // the daemon says one is registered for this origin. An account that signs in by email has its road here too, and
    // one with no Google sign-in (`withoutGoogle`) never has Google's gate raised at all: the prompt alone is the wall.
    | {
          readonly kind: `choose`;
          readonly target: SandboxTarget;
          readonly passkey: boolean;
          readonly email?: EmailRoad;
          readonly withoutGoogle?: true;
      }
    // A Google proof was accepted but this sandbox requires a passkey: confirm with the one held, or add a first one
    // under `bearer`; the owner may also spend a recovery code.
    | { readonly kind: `step-up`; readonly target: SandboxTarget; readonly enrolled: boolean; readonly bearer: StepUpBearer };

// Shallow: the prompt is replaced whole, and its target must stay the very object the session module raised it
// with, so the offer that lands later can tell it is for the same sign-in.
// allow(module-state): the one sign-in question, naming the daemon it is for
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

// Turns the standing prompt into the passkey step-up without settling it: the assertion "Continue as" spent was taken,
// and the sandbox's rule wants a passkey on top. The ceremony's session then settles the very establish that raised
// the choice. A no-op when nothing is waiting.
export const escalateSignIn = (target: SandboxTarget, required: PasskeyRequired, bearer: StepUpBearer): void => {
    if (settle !== undefined) {
        prompt.value = { kind: `step-up`, target, enrolled: required.enrolled, bearer };
    }
};

// Lets the passkey offer land after the prompt went up, without disturbing a prompt that moved on.
export const offerPasskey = (target: SandboxTarget, offered: boolean): void => {
    if (prompt.value?.kind === `choose` && prompt.value.target === target) {
        prompt.value = { ...prompt.value, passkey: offered };
    }
};

export function useSignInPrompt() {
    return { prompt, completeSignIn, dismissSignIn, escalateSignIn };
}
