import type { KeyringOp, KeyringResponse } from "../protocol.js";
import type { Challenge } from "./door.js";
import { NO_SESSION } from "./remote.js";

// When the session helper asks a person to prove they are at this computer. It asks once at sign-in. A proof the person
// turned down (Cancel, or the box closing unanswered while nobody was there) is NOT asked again on a timer: that put a
// recovery-key box up every two minutes, and a box nobody saw failed silently on a loop. It is asked again only when a
// request through this helper needed a person and was answered "nobody is signed in to ask".

export class ProofGate {
    #proven = false;
    #wanted = false;
    #wake: (() => void) | undefined;

    /** Whether the service has let this helper in, so prompts and typing reach this session. */
    get proven(): boolean {
        return this.#proven;
    }

    /** The service's verdict on this helper's proof, or the link to it lost (false). */
    settle(proven: boolean): void {
        this.#proven = proven;
        if (proven) {
            // Whatever wanted a person has one now.
            this.#wanted = false;
        }
    }

    /** After a proof turned down: resolves once something needs a person here (`want`), at once if it already did. */
    async whenWanted(): Promise<void> {
        if (!this.#wanted) {
            await new Promise<void>((resolve) => {
                this.#wake = resolve;
            });
        }
        this.#wanted = false;
        this.#wake = undefined;
    }

    /** A request needed a person: ask this session to prove itself again. */
    want(): void {
        this.#wanted = true;
        this.#wake?.();
    }
}

/** Whether `answer` is the service saying no helper was there to ask: what makes the helper ask for its proof again. */
export const neededPerson = (answer: KeyringResponse<KeyringOp>): answer is Extract<KeyringResponse<KeyringOp>, { ok: false }> => !answer.ok && answer.refusal.includes(NO_SESSION);

/** What the person reads instead, once the helper has put its proof box up: where to look, and what to do after. */
export const proofAsked = (method: Challenge["method"] | undefined): string =>
    method === "passphrase"
        ? "Passwords is asking for your recovery key, in a window on this computer's screen. Type it there, then try again."
        : "Passwords is asking you to confirm it is you, in a window on this computer's screen. Do that, then try again.";
