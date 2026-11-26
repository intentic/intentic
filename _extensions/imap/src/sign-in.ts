// A device-code sign-in the backend runs for `imap login` (oauth.ts deviceLogin): started by one tool call, which answers
// with Microsoft's page and the code once Microsoft gave them, and waited on by the next, since the person may take
// longer to type the code than one call may last. One per card at a time; a new start replaces a settled one.

export type SignInState = "pending" | "done" | "failed";

export interface SignInView {
    readonly state: SignInState;
    readonly lines: readonly string[];
}

export interface SignIns {
    // Starts the sign-in (unless one is still pending for the card) and answers once it said its first line or ended.
    readonly start: (card: string, run: (out: (line: string) => void) => Promise<void>) => Promise<SignInView>;
    // Waits up to `ms` for the card's sign-in to end; undefined when none was started.
    readonly wait: (card: string, ms: number) => Promise<SignInView | undefined>;
}

interface Running {
    state: SignInState;
    readonly lines: string[];
    readonly ended: Promise<void>;
    readonly spoke: Promise<void>;
}

const viewOf = (running: Running): SignInView => ({ state: running.state, lines: [...running.lines] });

const within = (ms: number, promise: Promise<void>): Promise<void> =>
    new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        void promise.then(() => {
            clearTimeout(timer);
            resolve();
        });
    });

export const signIns = (): SignIns => {
    const byCard = new Map<string, Running>();
    return {
        start: async (card, run) => {
            const current = byCard.get(card);
            if (current?.state === "pending") {
                return viewOf(current);
            }
            let spoken: () => void = () => undefined;
            const spoke = new Promise<void>((resolve) => {
                spoken = resolve;
            });
            const lines: string[] = [];
            const running: Running = {
                state: "pending",
                lines,
                spoke,
                ended: run((line) => {
                    lines.push(line);
                    spoken();
                }).then(
                    () => {
                        running.state = "done";
                    },
                    (error: Error) => {
                        lines.push(error.message);
                        running.state = "failed";
                    },
                ),
            };
            byCard.set(card, running);
            await Promise.race([spoke, running.ended]);
            return viewOf(running);
        },
        wait: async (card, ms) => {
            const running = byCard.get(card);
            if (running === undefined) {
                return undefined;
            }
            await within(ms, running.ended);
            return viewOf(running);
        },
    };
};
