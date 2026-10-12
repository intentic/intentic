import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type LengthMismatch, watchResponseLength } from "./response-length.js";

// A real Node server, since the point is what reaches the socket: `answer` writes the response under the watch.
const serving = async (answer: (response: ServerResponse) => void): Promise<LengthMismatch[]> => {
    const seen: LengthMismatch[] = [];
    let closed = (): void => {};
    const done = new Promise<void>((resolve) => {
        closed = resolve;
    });
    const server = createServer((incoming: IncomingMessage, outgoing: ServerResponse) => {
        watchResponseLength(outgoing, incoming.method ?? "GET", (mismatch) => seen.push(mismatch));
        outgoing.once("close", () => setImmediate(closed));
        answer(outgoing);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port answers its address as AddressInfo.
    const { port } = server.address() as AddressInfo;
    // The client reads what arrives, then hangs up: a browser waiting on a short body gives up the same way.
    const client = request({ port, host: "127.0.0.1", agent: false }, (response) => {
        response.on("data", () => {});
        setTimeout(() => client.destroy(), 50);
    });
    client.on("error", () => {});
    client.end();
    await done;
    server.close();
    return seen;
};

test("an answer ended short of its declared length is reported, with the encoding it claimed", async () => {
    const seen = await serving((outgoing) => {
        outgoing.writeHead(200, { "content-type": "application/json", "content-encoding": "zstd", "content-length": "100" });
        outgoing.end(Buffer.alloc(10));
    });
    expect(seen).toEqual([{ declared: 100, sent: 10, encoding: "zstd", aborted: expect.any(Boolean) }]);
});

test("an answer that kept its word is nothing, written in one piece or in many", async () => {
    expect(
        await serving((outgoing) => {
            outgoing.writeHead(200, { "content-length": "5" });
            outgoing.end("hello");
        }),
    ).toEqual([]);
    expect(
        await serving((outgoing) => {
            outgoing.writeHead(200, { "content-length": "6" });
            outgoing.write("abc");
            outgoing.end("def");
        }),
    ).toEqual([]);
});

test("a stream with no declared length, and a request with no Node response, are left alone", async () => {
    expect(
        await serving((outgoing) => {
            outgoing.writeHead(200, { "content-type": "text/event-stream" });
            outgoing.end("data: 1\n\n");
        }),
    ).toEqual([]);
    // `app.request` in tests hands no binding at all.
    expect(() => watchResponseLength(undefined, "GET", () => {})).not.toThrow();
});
