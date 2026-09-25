import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { ExtensionHost } from "../installed-extensions.js";
import type { ExtensionBackend } from "./backend-supervisor.js";
import { createExtensionMcpRoute, extensionMcpToolsOf } from "./extension-mcp.js";

// A card whose extension declares `mcp` gets one server per granted card, and the door forwards to that card's path in
// the backend with the turn's bearer swapped for the host token; everything else gets nothing.

const TOKEN = "extension-mcp-token";
const HOST_TOKEN = "host-token";

// One baked extension on disk: a cli card `acme` serving MCP at `mcp`, and a plain cli card `plain` that serves none.
const extensionsDir = (): string => {
    const root = mkdtempSync(join(tmpdir(), "ext-mcp-"));
    const dir = join(root, "acme");
    mkdirSync(dir, { recursive: true });
    const card = (id: string, extra: Record<string, unknown>) => ({
        id,
        kind: "cli",
        catalog: { name: id, icon: "plug", description: id, category: "business" },
        fields: [{ key: "token", label: "Token", secret: true }],
        env: { ACME_TOKEN: "${token}" },
        skill: "SKILL.md",
        ...extra,
    });
    writeFileSync(
        join(dir, "intentic-extension.json"),
        JSON.stringify({
            publisher: "test",
            name: "acme",
            version: "1.0.0",
            engines: { intentic: "^2.0.0" },
            server: "server.js",
            contributes: { capabilities: [card("acme", { mcp: "mcp" }), card("plain", {})] },
        }),
    );
    return root;
};

const hostFor = (capabilities: Capability[]): ExtensionHost & { extensionMcpToken: string } => ({
    workspace: { root: mkdtempSync(join(tmpdir(), "ext-mcp-ws-")) },
    files: { read: readWorkspaceFile },
    capabilities: { list: async () => capabilities },
    config: { extensionsDir: extensionsDir(), historyRoot: mkdtempSync(join(tmpdir(), "ext-mcp-history-")) },
    extensionMcpToken: TOKEN,
});

const acme: Capability = { id: "billing", kind: "cli", config: { provider: "acme", token: "t" } };
const plain: Capability = { id: "other", kind: "cli", config: { provider: "plain", token: "t" } };
// A card named after a daemon server would shadow it, so it mounts nothing.
const reserved: Capability = { id: "ui", kind: "cli", config: { provider: "acme", token: "t" } };

test("mounts one server per granted card whose contribution declares mcp", async () => {
    const host = hostFor([acme, plain, reserved]);
    expect(await extensionMcpToolsOf(host, [acme, plain, reserved], 8787)).toEqual([
        { name: "billing", url: "http://127.0.0.1:8787/mcp/extensions/billing", token: TOKEN },
    ]);
    expect(await extensionMcpToolsOf(host, [], 8787)).toEqual([]);
});

// The backend host stand-in: records what arrived and answers 200.
const backend = async (): Promise<{ server: Server; port: number; seen: { url?: string; headers?: IncomingHttpHeaders }[] }> => {
    const seen: { url?: string; headers?: IncomingHttpHeaders }[] = [];
    const server = createServer((req, res) => {
        seen.push({ ...(req.url === undefined ? {} : { url: req.url }), headers: req.headers });
        res.writeHead(200, { "content-type": "application/json" }).end(`{"ok":true}`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return { server, port: (server.address() as AddressInfo).port, seen };
};

test("the door checks its token, resolves the card and forwards onto the card's backend path", async () => {
    const upstream = await backend();
    try {
        const capabilities = [acme, plain];
        const host = hostFor(capabilities);
        const extensionBackend = {
            proxyTarget: () => ({ port: upstream.port, hostToken: HOST_TOKEN }),
            status: () => ({ state: "running", extensions: [] }),
        } as unknown as ExtensionBackend;
        const route = createExtensionMcpRoute({
            ...host,
            capabilities: { list: async () => capabilities, get: async (id: string) => capabilities.find((entry) => entry.id === id) },
            extensionBackend,
        } as unknown as Parameters<typeof createExtensionMcpRoute>[0]);
        const app = new Hono<AppEnv>().all("/mcp/extensions/:id", route);
        const post = (id: string, token: string) =>
            app.request(`/mcp/extensions/${id}?probe=1`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });

        expect((await post("billing", "wrong")).status).toBe(401);
        expect((await post("other", TOKEN)).status).toBe(404);
        expect((await post("missing", TOKEN)).status).toBe(404);
        expect(upstream.seen).toEqual([]);

        const answered = await post("billing", TOKEN);
        expect(answered.status).toBe(200);
        expect(upstream.seen).toHaveLength(1);
        expect(upstream.seen[0]?.url).toBe("/x/test.acme/mcp/billing?probe=1");
        expect(upstream.seen[0]?.headers?.["x-intentic-backend"]).toBe(HOST_TOKEN);
        expect(upstream.seen[0]?.headers?.["authorization"]).toBeUndefined();
    } finally {
        upstream.server.close();
    }
});
