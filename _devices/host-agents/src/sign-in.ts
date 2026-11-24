import { randomUUID } from "node:crypto";
import { type AuthMethod, methods } from "@agentclientprotocol/sdk/unstable";
import { errorMessage } from "@intentic/base/errors";
import type { LoginStart, LoginStatus } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import { z } from "zod";
import type { HarnessConnection } from "./connection.js";
import type { PlaceHost } from "./place.js";

// SIGNING A HARNESS IN, the harness's own way: nothing here holds a credential or speaks to a provider. An agent says
// over the protocol how it can be signed in, and this runs the first way that needs no terminal:
//
// - a method of the agent's own (Codex's "Login with ChatGPT"): `authenticate` is asked of the running agent, which
//   opens the browser on this computer itself and answers when the sign-in has landed;
// - a command of the agent's own (Claude Code's `auth login`): run here with no terminal, its page's address read off
//   what it prints, and finished when it exits.
//
// Either way the browser opens on the computer the reader is at, and the attempt finishes by itself (the contract's
// `device` flow): the card only waits. A method that needs a key in an environment variable is not a sign-in a card
// can do, and is left to the reader.

const ATTEMPT_LIFE_MS = 10 * 60_000;
// How long the start waits for the command to print its page's address before answering without one.
const URL_WAIT_MS = 6_000;

interface Attempt {
    status: LoginStatus;
    readonly expiresAt: number;
    readonly stop: AbortController;
}

// A method the agent runs as a command of its own: its arguments after the agent's own command.
const TerminalMethodSchema = z.looseObject({ type: z.literal(`terminal`), args: z.array(z.string()) });
const EnvMethodSchema = z.looseObject({ type: z.literal(`env_var`) });

// The first address in what a sign-in command printed; an OSC 8 hyperlink prints it twice, joined by the escape.
const URL_IN_LINE = /https?:\/\/[^\s\u001B\u0007"'<>]+/;

export interface SignIns {
    readonly start: (connection: HarnessConnection, host: PlaceHost, cwd: string, label: string, landed: () => void) => Promise<LoginStart>;
    // An attempt that is over before it began: the harness was already signed in.
    readonly settled: () => LoginStart;
    readonly status: (handshake: string) => LoginStatus;
    readonly cancel: (handshake: string) => void;
}

const answer = (handshake: string, url: string, expiresAt: number): LoginStart => ({ url, code: ``, state: ``, flow: `device`, variant: ``, handshake, expiresAt });

export const createSignIns = (now: () => number = Date.now): SignIns => {
    const attempts = new Map<string, Attempt>();
    const open = () => {
        for (const [handshake, held] of attempts) {
            if (held.expiresAt < now()) {
                held.stop.abort();
                attempts.delete(handshake);
            }
        }
        const handshake = randomUUID();
        const attempt: Attempt = { status: { status: `wait` }, expiresAt: now() + ATTEMPT_LIFE_MS, stop: new AbortController() };
        attempts.set(handshake, attempt);
        return { handshake, attempt };
    };

    const byCommand = async (
        connection: HarnessConnection,
        host: PlaceHost,
        cwd: string,
        args: readonly string[],
        attempt: Attempt,
        landed: () => void,
    ): Promise<string> => {
        let found: ((url: string) => void) | undefined;
        const url = new Promise<string>((resolve) => {
            found = resolve;
            setTimeout(() => resolve(``), URL_WAIT_MS).unref();
        });
        let tail = ``;
        void host
            .run([...connection.launch.argv, ...args], {
                cwd,
                env: connection.launch.env,
                timeoutMs: ATTEMPT_LIFE_MS,
                signal: attempt.stop.signal,
                // Left open: the command waits on it for a code the reader would paste, and ends at once on a closed one.
                keepStdin: true,
                onLine: (line) => {
                    tail = `${tail}\n${line}`.slice(-600);
                    const address = URL_IN_LINE.exec(line)?.[0];
                    if (address !== undefined) {
                        found?.(address);
                    }
                },
            })
            .then((ran) => {
                if (ran.code === 0) {
                    attempt.status = { status: `ok` };
                    landed();
                } else if (attempt.status.status === `wait`) {
                    attempt.status = { status: `error`, error: attempt.stop.signal.aborted ? `The sign-in was cancelled.` : tail.trim() || `The sign-in did not finish.` };
                }
            });
        return url;
    };

    const byAgent = (connection: HarnessConnection, method: AuthMethod, attempt: Attempt, landed: () => void): void => {
        void connection.agent.request(methods.agent.authenticate, { methodId: method.id }).then(
            () => {
                attempt.status = { status: `ok` };
                landed();
            },
            (error: Error) => {
                attempt.status = { status: `error`, error: errorMessage(error) };
            },
        );
    };

    return {
        start: async (connection, host, cwd, label, landed) => {
            const { handshake, attempt } = open();
            const method = connection.authMethods.find((offered) => !EnvMethodSchema.safeParse(offered).success);
            if (method === undefined) {
                attempt.status = { status: `error`, error: `${label} offers no sign-in a card can run. Sign in to it in a terminal, then try again.` };
                return answer(handshake, ``, attempt.expiresAt);
            }
            const command = TerminalMethodSchema.safeParse(method);
            if (command.success) {
                return answer(handshake, await byCommand(connection, host, cwd, command.data.args, attempt, landed), attempt.expiresAt);
            }
            byAgent(connection, method, attempt, landed);
            return answer(handshake, ``, attempt.expiresAt);
        },
        settled: () => {
            const { handshake, attempt } = open();
            attempt.status = { status: `ok` };
            return answer(handshake, ``, attempt.expiresAt);
        },
        status: (handshake) => attempts.get(handshake)?.status ?? { status: `error`, error: `That sign-in is no longer waiting. Start it again.` },
        cancel: (handshake) => {
            const attempt = attempts.get(handshake);
            attempt?.stop.abort();
            attempts.delete(handshake);
        },
    };
};
