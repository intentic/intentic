import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { nodeRequest } from "./node-request.js";

// Against a real local server, since chunk boundaries, a socket torn down mid-body and a client that stops reading are
// facts of the transport a stubbed request cannot show.

let server: Server | undefined;

afterEach(() => {
    server?.closeAllConnections();
    server?.close();
    server = undefined;
});

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// A server answering every request with `handler`, counting the connections that reached it.
const serve = async (handler: (request: IncomingMessage, response: ServerResponse) => void) => {
    const reached = { connections: 0, requests: 0 };
    const started = createServer((request, response) => {
        reached.requests += 1;
        handler(request, response);
    });
    started.on("connection", () => {
        reached.connections += 1;
    });
    server = started;
    await new Promise<void>((resolve) => started.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port reports an AddressInfo, never a pipe name.
    return { url: new URL(`http://127.0.0.1:${(started.address() as AddressInfo).port}/`), reached };
};

describe("nodeRequest", () => {
    it("decodes a character whose bytes arrive in two chunks", async () => {
        const bytes = Buffer.from("zł€", "utf8");
        const { url } = await serve((_request, response) => {
            response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
            // Split inside "ł" (two bytes), and flushed apart so the client reads two chunks.
            response.write(bytes.subarray(0, 2));
            void pause(30).then(() => response.end(bytes.subarray(2)));
        });

        const answer = await nodeRequest(url);

        expect(answer.body.toString("utf8")).toBe("zł€");
        expect(answer.truncated).toBe(false);
        expect(answer.status).toBe(200);
    });

    it("takes its abort listener off the caller's signal once it has settled", async () => {
        const { url } = await serve((_request, response) => response.end("ok"));
        const controller = new AbortController();
        const added = jest.spyOn(controller.signal, "addEventListener");
        const removed = jest.spyOn(controller.signal, "removeEventListener");

        await nodeRequest(url, { signal: controller.signal });

        expect(added).toHaveBeenCalledTimes(1);
        expect(added.mock.calls[0]?.[0]).toBe("abort");
        expect(removed).toHaveBeenCalledTimes(1);
        expect(removed.mock.calls[0]?.[0]).toBe("abort");
        expect(removed.mock.calls[0]?.[1]).toBe(added.mock.calls[0]?.[1]);
    });

    it("takes the listener off when the request fails, too", async () => {
        const { url } = await serve((request) => request.socket.destroy());
        const controller = new AbortController();
        const removed = jest.spyOn(controller.signal, "removeEventListener");

        await expect(nodeRequest(url, { signal: controller.signal })).rejects.toThrow(Error);

        expect(removed).toHaveBeenCalledTimes(1);
    });

    it("refuses a signal that has already aborted without sending anything", async () => {
        const { url, reached } = await serve((_request, response) => response.end("ok"));
        const reason = new Error("given up already");

        await expect(nodeRequest(url, { signal: AbortSignal.abort(reason) })).rejects.toBe(reason);

        await pause(50);
        expect(reached).toEqual({ connections: 0, requests: 0 });
    });

    it("rejects with the signal's reason when the caller aborts mid-exchange", async () => {
        const { url } = await serve((_request, response) => response.writeHead(200).flushHeaders());
        const controller = new AbortController();
        const reason = new Error("caller gave up");
        const pending = nodeRequest(url, { signal: controller.signal });
        await pause(50);
        controller.abort(reason);

        await expect(pending).rejects.toBe(reason);
    });

    it("rejects, rather than waiting for good, when the body is cut off mid-read", async () => {
        const { url } = await serve((_request, response) => {
            response.writeHead(200, { "content-length": "1000" });
            response.write("only part of it");
            void pause(30).then(() => response.socket?.destroy());
        });

        await expect(nodeRequest(url)).rejects.toThrow(Error);
    });

    it("rejects with the caller's idle error when the server goes quiet", async () => {
        const { url } = await serve(() => undefined);

        await expect(nodeRequest(url, { idleMs: 100, idleError: () => new Error("went quiet") })).rejects.toThrow("went quiet");
    });

    it("stops reading at maxBytes, keeps exactly that many, and closes the connection", async () => {
        const chunk = Buffer.alloc(16 * 1024, 0x61);
        let socket: Socket | undefined;
        let written = 0;
        const { url } = await serve((request, response) => {
            socket = request.socket;
            response.writeHead(200);
            // Far more than the cap, a chunk at a time, for as long as the client keeps the connection.
            const pump = (): void => {
                if (response.destroyed || request.socket.destroyed || written >= 256) {
                    response.end();
                    return;
                }
                written += 1;
                response.write(chunk);
                setTimeout(pump, 5);
            };
            pump();
        });

        const answer = await nodeRequest(url, { maxBytes: 40_000 });

        expect(answer.truncated).toBe(true);
        expect(answer.body.byteLength).toBe(40_000);
        await new Promise<void>((resolve) => (socket?.destroyed === true ? resolve() : socket?.once("close", () => resolve())));
        expect(socket?.destroyed).toBe(true);
        expect(written).toBeLessThan(256);
    });

    it("keeps a body that is exactly maxBytes whole", async () => {
        const { url } = await serve((_request, response) => response.end(Buffer.alloc(1000, 0x62)));

        const answer = await nodeRequest(url, { maxBytes: 1000 });

        expect(answer.truncated).toBe(false);
        expect(answer.body.byteLength).toBe(1000);
    });
});
