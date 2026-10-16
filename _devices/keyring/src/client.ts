import { connect } from "node:net";
import { KEYRING_LINE_MAX, KEYRING_RESPONSES, type KeyringRequest, type KeyringResponse } from "./protocol.js";

// A caller of the keyring's pipe (protocol.ts): intentic-machine relaying a sandbox's grant, its `keyring` commands,
// the desktop app through them, and intentic-askpass. One connection per request; an answer that does not parse as
// what its op promises is an error, not a partial result.

export class KeyringUnavailable extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "KeyringUnavailable";
    }
}

export interface KeyringClientOptions {
    readonly address: string;
    // How long to wait for an answer. Generous by default: a release may wait on a person at Windows Hello.
    readonly timeoutMs?: number;
}

// Two minutes and a little: a grant lives two minutes, so no answer worth waiting for comes later.
const DEFAULT_TIMEOUT_MS = 130_000;

export const askKeyring = async <R extends KeyringRequest>(options: KeyringClientOptions, request: R): Promise<KeyringResponse<R["op"]>> =>
    new Promise((resolve, reject) => {
        const socket = connect(options.address);
        let buffered = "";
        let settled = false;
        const finish = (outcome: () => void): void => {
            if (!settled) {
                settled = true;
                clearTimeout(timer);
                socket.destroy();
                outcome();
            }
        };
        const timer = setTimeout(
            () => finish(() => reject(new KeyringUnavailable(`the keyring did not answer within ${String(Math.round((options.timeoutMs ?? DEFAULT_TIMEOUT_MS) / 1000))} s`))),
            options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        );
        socket.setEncoding("utf8");
        socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
        socket.on("data", (chunk: string) => {
            buffered += chunk;
            if (buffered.length > KEYRING_LINE_MAX) {
                finish(() => reject(new KeyringUnavailable("the keyring answered with more than any answer holds")));
                return;
            }
            const end = buffered.indexOf("\n");
            if (end === -1) {
                return;
            }
            const line = buffered.slice(0, end);
            finish(() => {
                const schema = KEYRING_RESPONSES[request.op];
                let parsed: unknown;
                try {
                    parsed = JSON.parse(line);
                } catch (error) {
                    reject(new KeyringUnavailable("the keyring answered with something that is not JSON", { cause: error }));
                    return;
                }
                const answer = schema.safeParse(parsed);
                if (!answer.success) {
                    reject(new KeyringUnavailable(`the keyring's answer to ${request.op} is not one this build reads: is it a different version?`));
                    return;
                }
                // SAFETY: KEYRING_RESPONSES is keyed by op and parsed above with that op's own schema.
                resolve(answer.data as KeyringResponse<R["op"]>);
            });
        });
        socket.on("error", (error: NodeJS.ErrnoException) =>
            finish(() =>
                reject(
                    new KeyringUnavailable(
                        error.code === "ENOENT" || error.code === "ECONNREFUSED"
                            ? "no keyring is running on this computer: `intentic-machine keyring setup` installs one"
                            : `the keyring could not be reached: ${error.message}`,
                        { cause: error },
                    ),
                ),
            ),
        );
        socket.on("end", () => finish(() => reject(new KeyringUnavailable("the keyring closed the connection without an answer"))));
    });
