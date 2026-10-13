import { createServer, type Server } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { errorMessage } from "@intentic/base/errors";
import type { JsonValue } from "@intentic/base/fetch-json";

// Whatever an endpoint's answer threw, as errorMessage reads it.
type Thrown = Parameters<typeof errorMessage>[0];

// The daemon's end of a runtime's hook process: a Unix socket the hook script a runtime runs before its tools (Cursor's
// generated script today, any runtime's command hook tomorrow) posts its payload to and reads its answer from. A process
// this daemon wrote can hold its answer while a card waits on a person, which a vendor's clocked approval channel cannot.
// Owner-only (0600): anything that can write to it can allow what the owner's rules would refuse.

// What an endpoint answers: a JSON object, which the script prints as the hook's verdict.
export type HookAnswer = { readonly [key: string]: JsonValue };

// One endpoint: what it answers a payload with, what it answers one that is not JSON, and what it answers when its
// own answer threw. The second and third are the endpoint's to choose, since a gate fails closed and an environment
// lookup fails empty.
export interface HookEndpoint {
    readonly answer: (payload: JsonValue) => Promise<HookAnswer> | HookAnswer;
    readonly unreadable: HookAnswer;
    readonly failed?: (error: Thrown) => HookAnswer;
}

export interface HookSocket {
    // Clears a socket a dead daemon left behind, listens, and narrows it to the owner. Idempotent.
    readonly listen: () => Promise<void>;
    readonly listening: () => boolean;
    readonly close: () => Promise<void>;
}

export const createHookSocket = (path: string, endpoints: Readonly<Record<string, HookEndpoint>>): HookSocket => {
    let server: Server | undefined;
    return {
        listen: async () => {
            if (server !== undefined) {
                return;
            }
            await mkdir(dirname(path), { recursive: true });
            // An unclean shutdown can leave the socket behind, failing listen() forever; nothing else owns this path.
            await rm(path, { force: true });
            const created = createServer((request, response) => {
                // Lets a probe tell this daemon's socket from one a second daemon has since re-bound.
                if (request.url === "/identity") {
                    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ pid: process.pid }));
                    return;
                }
                const endpoint = request.method === "POST" && request.url !== undefined ? endpoints[request.url] : undefined;
                if (endpoint === undefined) {
                    response.writeHead(405).end();
                    return;
                }
                const answer = (body: HookAnswer): void => {
                    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body));
                };
                const chunks: Buffer[] = [];
                request.on("data", (chunk: Buffer) => chunks.push(chunk));
                request.on("end", () => {
                    let payload: JsonValue;
                    try {
                        // SAFETY: JSON.parse yields a JSON value or throws, and a throw is answered as unreadable below.
                        payload = JSON.parse(Buffer.concat(chunks).toString("utf8")) as JsonValue;
                    } catch {
                        // The same harmless verdict the script writes when it can't reach this socket at all.
                        answer(endpoint.unreadable);
                        return;
                    }
                    const failed = endpoint.failed ?? ((): HookAnswer => endpoint.unreadable);
                    void Promise.resolve()
                        .then(() => endpoint.answer(payload))
                        .catch(failed)
                        .then(answer);
                });
            });
            await new Promise<void>((settle, fail) => {
                created.once("error", fail);
                created.listen(path, () => {
                    created.removeListener("error", fail);
                    settle();
                });
            });
            await chmod(path, 0o600);
            server = created;
        },
        listening: () => server !== undefined,
        close: async () => {
            const running = server;
            server = undefined;
            if (running !== undefined) {
                await new Promise<void>((settle) => running.close(() => settle()));
            }
            await rm(path, { force: true });
        },
    };
};
