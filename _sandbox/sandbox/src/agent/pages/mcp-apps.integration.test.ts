import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, readMcpAppData } from "@intentic/sandbox-contract";
import { callForApp, callResultOf, McpAppHost } from "./mcp-apps.js";

// An MCP server's app drawn for one of its calls, and what the app may then ask of its server: against a fake server
// speaking Streamable HTTP (JSON for most answers, an event stream for one, as real servers mix them).

const SERVER = { name: "maps", url: "https://maps.example/mcp", token: "t0k" };

const TOOLS = [
    { name: "show_map", title: "Map", _meta: { ui: { resourceUri: "ui://maps/view.html" } } },
    { name: "zoom", annotations: { readOnlyHint: true } },
    { name: "save_pin", _meta: { ui: { visibility: ["app"] } } },
    { name: "delete_all", _meta: { ui: { visibility: ["model"] } } },
    { name: "plain" },
];

const APP_HTML = `<html><head><script src="https://tiles.example/sdk.js"></script></head><body><div id="map"></div></body></html>`;

// What the fake server was asked, by method, and the headers the asks carried.
const fakeServer = () => {
    const asked: { method: string; session: string | null; auth: string | null }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
        if (url === "https://tiles.example/sdk.js") {
            return new Response("window.mapSdk = true;", { status: 200 });
        }
        const body = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name?: string } };
        const headers = new Headers(init?.headers);
        asked.push({ method: body.method, session: headers.get("mcp-session-id"), auth: headers.get("authorization") });
        const answer = (result: unknown) => JSON.stringify({ jsonrpc: "2.0", id: body.id, result });
        switch (body.method) {
            case "initialize":
                return new Response(answer({ protocolVersion: "2025-06-18", capabilities: {} }), {
                    headers: { "content-type": "application/json", "mcp-session-id": "s-1" },
                });
            case "notifications/initialized":
                return new Response(null, { status: 202 });
            case "tools/list":
                // As an event stream, with a notification ahead of the answer.
                return new Response(`event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: ${answer({ tools: TOOLS })}\n\n`, {
                    headers: { "content-type": "text/event-stream" },
                });
            case "resources/read":
                return new Response(
                    answer({ contents: [{ uri: "ui://maps/view.html", mimeType: "text/html;profile=mcp-app", text: APP_HTML, _meta: { ui: { csp: { resourceDomains: ["https://tiles.example"] } } } }] }),
                    { headers: { "content-type": "application/json" } },
                );
            case "tools/call":
                return new Response(answer({ content: [{ type: "text", text: `called ${body.params?.name}` }] }), { headers: { "content-type": "application/json" } });
            default:
                return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { message: "no such method" } }), { headers: { "content-type": "application/json" } });
        }
    }) as unknown as typeof fetch;
    return { asked, fetcher };
};

describe("McpAppHost", () => {
    let root: string;
    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "mcp-apps-"));
    });
    afterEach(() => rmSync(root, { recursive: true, force: true }));

    it("draws a tool's app with its call inside, and the files it declares carried in", async () => {
        const { asked, fetcher } = fakeServer();
        const pushed: AgentEvent[] = [];
        const host = new McpAppHost({ servers: [SERVER], workspaceRoot: root, conversationId: "c1", push: (event) => pushed.push(event), fetch: fetcher });
        const page = await host.show("mcp__maps__show_map", { city: "Lisbon" }, [{ type: "text", text: "3 pins" }]);
        expect(page).toMatchObject({ title: "Map", app: { server: "maps", tool: "show_map" } });
        expect(pushed).toEqual([{ kind: "page", page: page! }]);
        const stored = readFileSync(join(root, page!.path), "utf8");
        expect(stored).toContain("<script>window.mapSdk = true;</script>");
        expect(readMcpAppData(stored)).toEqual({ server: "maps", tool: "show_map", input: { city: "Lisbon" }, result: { content: [{ type: "text", text: "3 pins" }] } });
        // One handshake, then the session the server minted on everything after; the bearer on all of it.
        expect(asked.map((ask) => ask.method)).toEqual(["initialize", "notifications/initialized", "tools/list", "resources/read"]);
        expect(asked.slice(1).every((ask) => ask.session === "s-1" && ask.auth === "Bearer t0k")).toBe(true);
    });

    it("draws nothing for a tool with no app, or a server nobody connected, and reads each list once", async () => {
        const { asked, fetcher } = fakeServer();
        const host = new McpAppHost({ servers: [SERVER], workspaceRoot: root, push: () => undefined, fetch: fetcher });
        expect(await host.show("mcp__maps__plain", {}, "ok")).toBeUndefined();
        expect(await host.show("mcp__maps__zoom", {}, "ok")).toBeUndefined();
        expect(await host.show("mcp__other__show_map", {}, "ok")).toBeUndefined();
        expect(asked.filter((ask) => ask.method === "tools/list")).toHaveLength(1);
    });
});

describe("callForApp", () => {
    it("calls what the app may call: a read-only tool on its own, anything else only from a press", async () => {
        const { fetcher } = fakeServer();
        expect(await callForApp(SERVER, { name: "zoom", pressed: false }, fetcher)).toEqual({ result: { content: [{ type: "text", text: "called zoom" }] } });
        expect(await callForApp(SERVER, { name: "save_pin", pressed: false }, fetcher)).toMatchObject({ refused: expect.stringContaining("press") });
        expect(await callForApp(SERVER, { name: "save_pin", pressed: true }, fetcher)).toEqual({ result: { content: [{ type: "text", text: "called save_pin" }] } });
    });

    it("never calls a tool its server keeps for the model, or one it does not have", async () => {
        const { fetcher } = fakeServer();
        expect(await callForApp(SERVER, { name: "delete_all", pressed: true }, fetcher)).toMatchObject({ refused: expect.stringContaining("agent alone") });
        expect(await callForApp(SERVER, { name: "nope", pressed: true }, fetcher)).toMatchObject({ refused: expect.stringContaining("no tool") });
    });
});

describe("callResultOf", () => {
    it("reads any shape a runtime hands its hook as an MCP call result", () => {
        expect(callResultOf("hi")).toEqual({ content: [{ type: "text", text: "hi" }] });
        expect(callResultOf([{ type: "text", text: "a" }])).toEqual({ content: [{ type: "text", text: "a" }] });
        expect(callResultOf({ content: [], structuredContent: { n: 1 } })).toEqual({ content: [], structuredContent: { n: 1 } });
    });
});
