import { createServer, type Server } from "node:http";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AgentEvent } from "@intentic/sandbox-contract";
import { afterEach, expect, test } from "vitest";
import { createDaemonClient } from "./daemon-client.js";

/* The HTTP layer over a real node:http server: SSE framing round-trips AgentEvents (unknown kinds skipped),
 * the bridge token header rides every call, 401 → ACP auth_required. */

let server: Server | undefined;
afterEach(() => server?.close());

const serve = async (handler: Parameters<typeof createServer>[1]): Promise<string> => {
    server = createServer(handler);
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
        throw new Error("no port");
    }
    return `http://127.0.0.1:${address.port}`;
};

test("streamTurn posts the turn with the bridge header and yields parsed frames, skipping unknown kinds", async () => {
    let seenToken: string | undefined;
    let seenBody = "";
    const url = await serve((request, response) => {
        seenToken = request.headers["x-intentic-control"] as string;
        request.on("data", (chunk: Buffer) => (seenBody += chunk.toString()));
        request.on("end", () => {
            response.writeHead(200, { "content-type": "text/event-stream" });
            response.write(`data: ${JSON.stringify({ kind: "delta", text: "hi" })}\n\n`);
            response.write(`data: ${JSON.stringify({ kind: "brand-new-kind", weird: true })}\n\n`);
            response.write(`data: ${JSON.stringify({ kind: "done" })}\n\n`);
            response.end();
        });
    });
    const events: AgentEvent[] = [];
    for await (const event of createDaemonClient(url, "ict_x").streamTurn({ prompt: "hi" }, new AbortController().signal)) {
        events.push(event);
    }
    expect(seenToken).toBe("ict_x");
    expect(JSON.parse(seenBody)).toEqual({ prompt: "hi" });
    expect(events).toEqual([{ kind: "delta", text: "hi" }, { kind: "done" }]);
});

test("a 401 surfaces as ACP auth_required; other failures name the status", async () => {
    const url = await serve((_request, response) => {
        response.writeHead(401);
        response.end("nope");
    });
    const client = createDaemonClient(url, "ict_revoked");
    await expect(client.listSessions()).rejects.toSatisfy((error) => error instanceof RequestError && error.code === -32000);
});
