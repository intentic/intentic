import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { type Account, bindingOf } from "./accounts.js";
import { deviceLogin, type Http } from "./auth.js";
import type { StoreToken } from "./sessions.js";

// Microsoft's device-code sign-in, run in the backend so the refresh token it ends with goes straight onto the card
// and never through the agent's shell. `start` answers Microsoft's page and the code for the person to type; `wait`
// holds a call until the sign-in settles or a while passes, and the CLI asks again until it does.

// The longest one wait holds a call, under the backend host's ten minutes for a tool call.
const WAIT_MS = 8 * 60_000;

interface Running {
    readonly line: Promise<string>;
    readonly done: Promise<void>;
    settled?: { readonly ok: boolean; readonly message: string };
}

export interface SignInState {
    readonly state: "pending" | "done";
    readonly message: string;
}

export interface SignIns {
    readonly start: (account: Account) => Promise<string>;
    readonly wait: (account: Account, signal: AbortSignal) => Promise<SignInState>;
}

export interface SignInDeps {
    readonly store: StoreToken;
    // The card's refresh token as the daemon holds it now: the watcher may rotate it while the person types the code.
    readonly current: (id: string) => Promise<string | undefined>;
    readonly http: Http;
    readonly pause: (ms: number) => Promise<void>;
}

const SIGNED_IN = "Signed in. The sign-in is stored on the Microsoft 365 card; the next command uses it.";

export const createSignIns = (deps: SignInDeps): SignIns => {
    const running = new Map<string, Running>();
    const begin = (account: Account): Running => {
        let show: (line: string) => void = () => undefined;
        const line = new Promise<string>((resolve) => {
            show = resolve;
        });
        const entry: Running = {
            line,
            done: deviceLogin(
                account,
                async (refreshToken, previous, login) => {
                    // allow(silent-catch): an unreadable card falls back to the token the sign-in started from; the daemon's store refuses a stale one in words
                    const current = (await deps.current(account.id).catch(() => undefined)) ?? previous;
                    await deps.store({ id: account.id, binding: bindingOf(account), previous: current, refreshToken, login: login === true });
                },
                (text) => show(text),
                { http: deps.http, pause: deps.pause },
            ).then(
                () => {
                    entry.settled = { ok: true, message: SIGNED_IN };
                },
                (error: Error) => {
                    entry.settled = { ok: false, message: errorMessage(error) };
                },
            ),
        };
        return entry;
    };
    return {
        start: async (account) => {
            const known = running.get(account.id);
            if (known !== undefined && known.settled === undefined) {
                return known.line;
            }
            const entry = begin(account);
            running.set(account.id, entry);
            const first = await Promise.race([entry.line, entry.done.then(() => undefined)]);
            if (first !== undefined) {
                return first;
            }
            running.delete(account.id);
            if (entry.settled?.ok !== true) {
                throw new Error(entry.settled?.message ?? "the sign-in did not start");
            }
            return entry.settled.message;
        },
        wait: async (account, signal) => {
            const entry = running.get(account.id);
            if (entry === undefined) {
                throw new Error("No sign-in is waiting for this card: start one with `m365 auth login`");
            }
            await Promise.race([entry.done, sleep(WAIT_MS, { signal })]);
            if (entry.settled === undefined) {
                return { state: "pending", message: "Still waiting for the person to sign in on Microsoft's page." };
            }
            running.delete(account.id);
            if (!entry.settled.ok) {
                throw new Error(entry.settled.message);
            }
            return { state: "done", message: entry.settled.message };
        },
    };
};
