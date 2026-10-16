import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { KEYRING_LINE_MAX, type KeyringOp, type KeyringRequest, KeyringRequestSchema, type KeyringResponse, type Refusal } from "./protocol.js";

// The keyring's pipe (protocol.ts): one JSON line in, one out, one request per connection. Nothing about the caller is
// trusted here (protocol.ts says why); the server only frames, parses and hands each request to the core. A request
// line is held to KEYRING_LINE_MAX and to a deadline, so a caller that never finishes its line cannot pin a connection.

export interface KeyringHandler {
    readonly handle: (request: KeyringRequest) => Promise<KeyringResponse<KeyringOp>>;
}

export type ServerLog = (message: string) => void;

// How long a caller has to send its one line.
const REQUEST_DEADLINE_MS = 10_000;

const answerLine = (answer: KeyringResponse<KeyringOp> | Refusal): string => `${JSON.stringify(answer)}\n`;

const failed = (refusal: string): string => answerLine({ ok: false, code: "unavailable", refusal });

const serveConnection = (handler: KeyringHandler, socket: Socket, log: ServerLog): void => {
    let buffered = "";
    let answered = false;
    socket.setEncoding("utf8");
    const deadline = setTimeout(() => socket.destroy(), REQUEST_DEADLINE_MS);
    const reply = (line: string): void => {
        answered = true;
        clearTimeout(deadline);
        socket.end(line);
    };
    socket.on("data", (chunk: string) => {
        if (answered) {
            return;
        }
        buffered += chunk;
        if (buffered.length > KEYRING_LINE_MAX) {
            reply(failed("That request is longer than any the keyring reads."));
            return;
        }
        const end = buffered.indexOf("\n");
        if (end === -1) {
            return;
        }
        // The line is in: the person may take a while to answer, which the deadline above must not cut short.
        clearTimeout(deadline);
        answered = true;
        void answerRequestLine(handler, buffered.slice(0, end), log).then((line) => {
            if (!socket.destroyed) {
                socket.end(line);
            }
        });
    });
    socket.on("error", () => socket.destroy());
};

// One request line answered as a line: shared with the hardened service's door, which frames its requests the same way.
export const answerRequestLine = async (handler: KeyringHandler, line: string, log: ServerLog): Promise<string> => {
    let json: unknown;
    try {
        json = JSON.parse(line);
    } catch {
        return answerLine({ ok: false, code: "bad-grant", refusal: "The keyring reads one JSON request per line." });
    }
    const request = KeyringRequestSchema.safeParse(json);
    if (!request.success) {
        return answerLine({ ok: false, code: "bad-grant", refusal: "That is not a request this keyring reads: is the caller a different version?" });
    }
    try {
        return answerLine(await handler.handle(request.data));
    } catch (error) {
        // The op's name only: a request can carry a sealed value or a grant's details, neither of which belongs in a log.
        log(`${request.data.op} failed: ${error instanceof Error ? error.message : "unknown error"}`);
        return failed(`The keyring could not answer ${request.data.op}: see ~/.intentic/keyring/keyring.log.`);
    }
};

// Listens on `address`. A unix socket is replaced if one is left from a keyring that stopped (the caller holds the
// pidfile, so no live keyring owns it) and narrowed to this user; a Windows pipe name is the pipe itself.
export const serveKeyring = async (handler: KeyringHandler, address: string, log: ServerLog, platform: NodeJS.Platform = process.platform): Promise<Server> => {
    if (platform !== "win32") {
        await rm(address, { force: true });
    }
    const server = createServer((socket) => serveConnection(handler, socket, log));
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(address, () => {
            server.off("error", reject);
            resolve();
        });
    });
    if (platform !== "win32") {
        await chmod(address, 0o600);
    }
    return server;
};
