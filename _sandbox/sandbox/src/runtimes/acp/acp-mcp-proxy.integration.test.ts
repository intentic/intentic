import { spawn } from "node:child_process";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createInterface } from "node:readline";
import { acpMcpProxyFile, PROXY_BEARER_ENV, PROXY_URL_ENV, stdioProxyServer } from "./acp-mcp-proxy.js";

// The proxy as an agent runs it: the script spawned on node with the env the stdio server names, JSON-RPC in on stdin,
// what a stand-in door answers out on stdout.

interface Seen {
    readonly headers: IncomingHttpHeaders;
    readonly body: { readonly id?: unknown; readonly method?: string };
}

let server: Server;
let url: string;
const seen: Seen[] = [];

beforeAll(async () => {
    server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (text === "") {
                response.writeHead(400).end();
                return;
            }
            // SAFETY: only the proxy posts here, and it forwards the JSON-RPC lines this test wrote.
            const body = JSON.parse(text) as Seen["body"];
            seen.push({ headers: request.headers, body });
            if (body.method === "initialize") {
                response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "door-session" });
                response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18" } }));
                return;
            }
            if (body.id === undefined) {
                response.writeHead(202).end();
                return;
            }
            if (body.method === "tools/list") {
                response.writeHead(200, { "content-type": "text/event-stream" });
                response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: {} })}\n\n`);
                response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })}\n\n`);
                return;
            }
            response.writeHead(401).end();
        });
    });
    await new Promise<void>((settle) => server.listen(0, "127.0.0.1", settle));
    // SAFETY: a server listening on a TCP port has an AddressInfo address.
    url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp/ui`;
});

afterAll(async () => {
    await new Promise<void>((settle) => server.close(() => settle()));
});

test("the stdio server names the proxy on node, its door and bearer in the environment rather than argv", async () => {
    const script = await acpMcpProxyFile();
    const config = stdioProxyServer({ name: "ui", url: "http://door/mcp/ui", token: "lease" }, script, "/usr/bin/node");
    expect(config).toEqual({
        name: "ui",
        command: "/usr/bin/node",
        args: [script],
        env: [
            { name: PROXY_URL_ENV, value: "http://door/mcp/ui" },
            { name: PROXY_BEARER_ENV, value: "lease" },
        ],
    });
});

test("lines go to the door with the bearer, the session and the protocol replayed; JSON, SSE and errors come back as lines", async () => {
    const script = await acpMcpProxyFile();
    // On node, as the daemon runs it: the test runner's own binary is bun.
    const child = spawn("node", [script], { env: { ...process.env, [PROXY_URL_ENV]: url, [PROXY_BEARER_ENV]: "lease" }, stdio: ["pipe", "pipe", "inherit"] });
    const out = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
    // SAFETY: every line the proxy writes is one JSON-RPC message, which is an object.
    const next = async (): Promise<Record<string, unknown>> => JSON.parse((await out.next()).value as string) as Record<string, unknown>;
    const send = (message: object): void => {
        child.stdin.write(`${JSON.stringify(message)}\n`);
    };

    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } });
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect((await next())["method"]).toBe("notifications/progress");
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
    send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask" } });
    expect(await next()).toEqual({ jsonrpc: "2.0", id: 3, error: { code: -32603, message: "The sandbox's MCP door answered HTTP 401." } });
    child.stdin.end();
    await new Promise((settle) => child.once("exit", settle));

    expect(seen.map((each) => each.headers.authorization)).toEqual(["Bearer lease", "Bearer lease", "Bearer lease", "Bearer lease"]);
    expect(seen[0]?.headers["mcp-session-id"]).toBeUndefined();
    expect(seen.slice(1).map((each) => [each.headers["mcp-session-id"], each.headers["mcp-protocol-version"]])).toEqual([
        ["door-session", "2025-06-18"],
        ["door-session", "2025-06-18"],
        ["door-session", "2025-06-18"],
    ]);
});
