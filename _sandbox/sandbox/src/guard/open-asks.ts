// Cards a device gate raised that are still open, or answered and not yet collected, by the exact call that raised
// them: the same call again waits on the same card instead of raising a second one, and a yes given after the first
// call gave up is still used, once. An answer nobody came back for is dropped when its turn ends, so a later turn's
// same call is asked about afresh. One per gate (host-command-guard.ts, host-restart-guard.ts), each with its own keys.

export interface OpenAsks<Answer> {
    // The card still open (or uncollected) under `key`.
    readonly get: (key: string) => Promise<Answer> | undefined;
    // Keeps `asking` under `key` until it is collected or `turnFinished` settles, whichever comes first.
    readonly hold: (key: string, asking: Promise<Answer>, turnFinished: Promise<void>) => void;
    // Waits on `asking` for `budgetMs`: its answer, collected so it is used once, or `waiting` with the card left up.
    readonly await: (key: string, asking: Promise<Answer>, budgetMs: number, waiting: Answer) => Promise<Answer>;
    // Keeps an answer past its turn's end, for the turn a wake starts to collect (guard/held-cards.ts): until it is
    // collected or `ms` passes, whichever comes first.
    readonly carry: (key: string, asking: Promise<Answer>, ms: number) => void;
}

export const createOpenAsks = <Answer>(): OpenAsks<Answer> => {
    const open = new Map<string, Promise<Answer>>();
    // Only the promise that was held is dropped: a newer card under the same key outlives the old one's collection.
    const collect = (key: string, asking: Promise<Answer>): void => {
        if (open.get(key) === asking) {
            open.delete(key);
        }
    };
    return {
        get: (key) => open.get(key),
        hold: (key, asking, turnFinished) => {
            open.set(key, asking);
            void turnFinished.then(() => collect(key, asking));
        },
        carry: (key, asking, ms) => {
            // A promise of its own, so the turn-end collect of the one it carries (matched by identity) leaves it be.
            const carried = asking.then((answer) => answer);
            open.set(key, carried);
            setTimeout(() => collect(key, carried), ms).unref();
        },
        await: async (key, asking, budgetMs, waiting) => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            const waited = new Promise<{ readonly waiting: true }>((resolve) => {
                timer = setTimeout(() => resolve({ waiting: true }), Math.max(0, budgetMs));
            });
            try {
                const outcome = await Promise.race([asking.then((answer) => ({ waiting: false as const, answer })), waited]);
                if (outcome.waiting) {
                    return waiting;
                }
                collect(key, asking);
                return outcome.answer;
            } finally {
                clearTimeout(timer);
            }
        },
    };
};
