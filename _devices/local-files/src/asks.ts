import { randomUUID } from "node:crypto";
import type { AnswerMessage, AskVerb, ControlEvent } from "./control.js";

// What this process asks of the app that started it, over the control channel: one `ask` line out, one `answer` line
// back with the same id. The app does what only a program the user runs should do, such as moving an entry to the
// system's trash. An app too old to know the ask never answers, so every ask ends on its own after a while, and every
// ask still open ends when the app lets go of this process.

// Long enough for the system's own dialog (Windows can ask before it recycles a large folder) and a large folder's own
// move, short enough that the window asking is not left waiting on an app that will never answer.
export const ASK_TIMEOUT_MS = 120_000;

// Why an ask ended with no answer, in words the window can show. The app may still be at it, and whatever it does
// reaches the window as any change on disk does, so neither says the move did not happen.
export const NO_ANSWER = `The app hasn't said whether this went to the Trash. It may still go there; the folder will show it if it does.`;
export const APP_GONE = `The app stopped before saying whether this went to the Trash. Look in the folder to see where it is.`;

interface Pending {
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
}

export class Asks {
    readonly #pending = new Map<string, Pending>();

    constructor(
        private readonly say: (event: ControlEvent) => void,
        private readonly timeoutMs = ASK_TIMEOUT_MS,
    ) {}

    // Settles once the app has done it, and rejects with the app's own words when it could not.
    ask(verb: AskVerb, path: string): Promise<void> {
        const id = randomUUID();
        const { promise, resolve, reject } = Promise.withResolvers<void>();
        const timer = setTimeout(() => this.#settle(id, new Error(NO_ANSWER)), this.timeoutMs);
        this.#pending.set(id, { resolve, reject, timer });
        this.say({ event: `ask`, id, verb, path });
        return promise;
    }

    // Whether the answer was to an ask still open; one that ended already, or was never asked, is dropped.
    answer(message: AnswerMessage): boolean {
        if (!this.#pending.has(message.id)) {
            return false;
        }
        this.#settle(message.id, message.ok ? undefined : new Error(message.error ?? `The app couldn't do that.`));
        return true;
    }

    // Ends every open ask, when nothing can answer them any more.
    close(): void {
        // Settling deletes the entry, which a Map's own iteration allows.
        for (const id of this.#pending.keys()) {
            this.#settle(id, new Error(APP_GONE));
        }
    }

    #settle(id: string, failure: Error | undefined): void {
        const pending = this.#pending.get(id);
        if (pending === undefined) {
            return;
        }
        this.#pending.delete(id);
        clearTimeout(pending.timer);
        if (failure === undefined) {
            pending.resolve();
        } else {
            pending.reject(failure);
        }
    }
}
