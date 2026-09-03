import { createServer, type Server } from "node:http";
import { RequestError } from "@agentclientprotocol/sdk";
import type { AttachFrame } from "@intentic/sandbox-contract";
import { afterEach, expect, test } from "vitest";
import { createDaemonClient } from "./daemon-client.js";

/* The HTTP layer over a real node:http server: the turn is started and then watched (two requests), the SSE
 * framing round-trips attach frames (unknown shapes skipped), the bridge token header rides every call, 401 →
 * ACP auth_required. */

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

test("streamTurn starts the turn, attaches to the run it named, and yields parsed frames, skipping unknown shapes", async () => {
    const seenTokens: (string | undefined)[] = [];
    const bodies: Record<string, string> = {};
    const url = await serve((request, response) => {
        seenTokens.push(request.headers["x-intentic-control"] as string);
        let body = "";
        request.on("data", (chunk: Buffer) => (body += chunk.toString()));
        request.on("end", () => {
            bodies[request.url ?? ""] = body;
            if (request.url === "/agent") {
                response.writeHead(200, { "content-type": "application/json" });
                response.end(JSON.stringify({ run: "run-7" }));
                return;
            }
            response.writeHead(200, { "content-type": "text/event-stream" });
            const head: AttachFrame = { kind: "attached", run: "run-7", startedAt: 5, seq: 0, rows: [{ role: "user", text: "hi" }] };
            response.write(`data: ${JSON.stringify(head)}\n\n`);
            response.write(`data: ${JSON.stringify({ kind: "patch", seq: 1, patch: { op: "text", index: 1, text: "hi" } })}\n\n`);
            response.write(`data: ${JSON.stringify({ kind: "brand-new-kind", weird: true })}\n\n`);
            response.write(`data: ${JSON.stringify({ kind: "end" })}\n\n`);
            response.end();
        });
    });
    const frames: AttachFrame[] = [];
    for await (const frame of createDaemonClient(url, "ict_x").streamTurn({ prompt: "hi", conversationId: "acp-1" }, new AbortController().signal)) {
        frames.push(frame);
    }
    expect(seenTokens).toEqual(["ict_x", "ict_x"]);
    expect(JSON.parse(bodies["/agent"] ?? "")).toEqual({ prompt: "hi", conversationId: "acp-1" });
    expect(JSON.parse(bodies["/agent/attach"] ?? "")).toEqual({ conversationId: "acp-1", run: "run-7" });
    expect(frames).toEqual([
        { kind: "attached", run: "run-7", startedAt: 5, seq: 0, rows: [{ role: "user", text: "hi" }] },
        { kind: "patch", seq: 1, patch: { op: "text", index: 1, text: "hi" } },
        { kind: "end" },
    ]);
});

test("a 401 surfaces as ACP auth_required; other failures name the status", async () => {
    const url = await serve((_request, response) => {
        response.writeHead(401);
        response.end("nope");
    });
    const client = createDaemonClient(url, "ict_revoked");
    await expect(client.listSessions()).rejects.toSatisfy((error) => error instanceof RequestError && error.code === -32000);
});
