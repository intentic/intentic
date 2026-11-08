import type { KeyringOp, KeyringResponse } from "../protocol.js";
import type { Challenge } from "./door.js";
import { NO_SESSION, RECOVERY_FILE } from "./remote.js";

// When the session helper asks a person to prove they are at this computer. It asks once at sign-in. A proof the person
// turned down (Cancel, or the box closing unanswered while nobody was there) is NOT asked again on a timer: that put a
// recovery-key box up every two minutes, and a box nobody saw failed silently on a loop. It is asked again only when a
// request through this helper needed a person and was answered "nobody is signed in to ask".
//
// A helper waiting like that still looks again, without asking anyone, when the service behind the door is a new one
// (2026-11-08). Starting Passwords over restarts the service with no vault, whose challenge needs nobody; a helper that
// slept through it was not there when setup ran, so Windows Hello was never enrolled and the new vault opened with the
// recovery key alone, asked for at every sign-in and every yes.

/** Why a waiting helper woke: a request needed a person, or the service behind the door restarted. */
export type Wake = "wanted" | "restarted";

export class ProofGate {
    #proven = false;
    #wanted = false;
    #restarted = false;
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

    /**
     * After a proof turned down: resolves once something needs a person here (`want`) or the service restarted
     * (`restarted`), at once if either already happened. A need wins over a restart: only a need may ask the person.
     */
    async whenWanted(): Promise<Wake> {
        if (!this.#wanted && !this.#restarted) {
            await new Promise<void>((resolve) => {
                this.#wake = resolve;
            });
        }
        const why: Wake = this.#wanted ? "wanted" : "restarted";
        this.#wanted = false;
        this.#restarted = false;
        this.#wake = undefined;
        return why;
    }

    /** The door names a different service now (a reset or an update restarted it): look at what it asks, asking nobody. */
    restarted(): void {
        this.#restarted = true;
        this.#wake?.();
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
        ? `Passwords is asking for your recovery key in a window on this computer's screen. It is the XXXXX-XXXXX-… key shown when Passwords was set up (saved as ${RECOVERY_FILE} if you kept the file), not a password of yours. Paste it there, then try again.`
        : "Passwords is asking you to confirm it is you, in a window on this computer's screen. Do that, then try again.";
