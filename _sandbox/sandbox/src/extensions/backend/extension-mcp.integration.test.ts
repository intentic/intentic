import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { createTurnMounts } from "../../agent/tools/turn-mounts.js";
import { createTurnMountRoute, type MountEndpoints } from "../../agent/tools/turn-mounts.routes.js";
import type { AppEnv } from "../../app-env.js";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import type { ExtensionHost } from "../installed-extensions.js";
import type { ExtensionBackend } from "./backend-supervisor.js";
import { createExtensionMcpEndpoint, extensionMcpToolsOf } from "./extension-mcp.js";

// A card whose extension serves it tools gets one server per granted card, mounted on the turn's lease. Here through the
// cli card's `mcp`, the alias kept one release: the daemon's MCP door forwards to that card's path in the backend with
// the conversation's bearer swapped for the host token and the card's settings attached; everything else gets nothing.
// Host-served tools (`api.tools.serve`) run against a real backend host in backend.integration.test.ts.

const HOST_TOKEN = "host-token";

// One baked extension on disk: a cli card `acme` serving MCP at `mcp`, and a plain cli card `plain` that serves none.
const extensionsDir = (ownServers: readonly string[] = []): string => {
    const root = mkdtempSync(join(tmpdir(), "ext-mcp-"));
    // Extensions serving tools of their own, no card: one server each, named by the extension's `name`.
    for (const name of ownServers) {
        mkdirSync(join(root, name), { recursive: true });
        writeFileSync(
            join(root, name, "intentic-extension.json"),
            JSON.stringify({ publisher: "test", name, version: "1.0.0", engines: { intentic: "^2.0.0" }, server: "server.js", contributes: { tools: {} } }),
        );
    }
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

const hostFor = (capabilities: Capability[], ownServers: readonly string[] = []) =>
    ({
        workspace: { root: mkdtempSync(join(tmpdir(), "ext-mcp-ws-")) },
        files: { read: readWorkspaceFile },
        capabilities: { list: async () => capabilities },
        config: { extensionsDir: extensionsDir(ownServers), historyRoot: mkdtempSync(join(tmpdir(), "ext-mcp-history-")) },
    }) satisfies ExtensionHost;

const mountsAt = () => createTurnMounts({ baseUrl: () => "http://127.0.0.1:8787/mcp" });

const acme: Capability = { id: "billing", kind: "cli", config: { provider: "acme", token: "t" } };
const plain: Capability = { id: "other", kind: "cli", config: { provider: "plain", token: "t" } };
// A card named after a daemon server would shadow it, so it mounts nothing.
const reserved: Capability = { id: "ui", kind: "cli", config: { provider: "acme", token: "t" } };

test("mounts one server per granted card whose extension serves its kind tools, on the turn's lease", async () => {
    const host = hostFor([acme, plain, reserved]);
    const mounts = mountsAt();
    const tools = await extensionMcpToolsOf(host, [acme, plain, reserved], mounts.lease("conv-a"), undefined);
    const token = tools[0]?.token ?? "";
    expect(tools).toEqual([{ name: "billing", url: "http://127.0.0.1:8787/mcp/billing", token }]);
    expect(mounts.resolve(token, "billing")).toEqual({
        target: { kind: "extension", extension: "test.acme", card: "billing", path: "mcp" },
        conversationId: "conv-a",
    });
    // The plain card serves no MCP, and the reserved one would shadow a daemon server: neither is on the lease.
    expect(mounts.resolve(token, "other")).toEqual({ refused: "unleased" });
    expect(mounts.resolve(token, "ui")).toEqual({ refused: "unleased" });
    // Nothing granted mounts nothing, and mints no bearer.
    expect(await extensionMcpToolsOf(host, [], mounts.lease(), undefined)).toEqual([]);
});

// A card is the grant for its server; an extension's own server (no card) is granted by the persona's `extensions`
// shelf, so a persona that was not given the extension does not get its tools mounted.
test("an extension's card-less server mounts only into a turn whose persona's extensions shelf grants it", async () => {
    const host = hostFor([acme], ["ledger", "notes"]);
    const names = async (shelf: readonly string[] | undefined): Promise<string[]> =>
        (await extensionMcpToolsOf(host, [acme], mountsAt().lease("conv-a"), shelf)).map((tool) => tool.name).toSorted();
    // Absent: every enabled extension's own server, beside the granted card's.
    expect(await names(undefined)).toEqual(["billing", "ledger", "notes"]);
    // Named: only those. Empty: none of them, while the card still rides the connectors grant.
    expect(await names(["test.ledger"])).toEqual(["billing", "ledger"]);
    expect(await names([])).toEqual(["billing"]);
    // Naming the extension that serves the card grants nothing extra: the card comes from `granted` alone.
    expect(await names(["test.acme"])).toEqual(["billing"]);
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

test("the door checks the bearer's lease, resolves the card and forwards onto the card's backend path", async () => {
    const upstream = await backend();
    try {
        const capabilities = [acme, plain];
        const host = hostFor(capabilities);
        const mounts = mountsAt();
        const card = (id: string) => ({ name: id, target: { kind: "extension", extension: "test.acme", card: id, path: "mcp" } as const });
        // Turn A is granted billing (and the plain card, which serves no MCP); turn B, another conversation, is granted
        // nothing that serves MCP but holds a bearer of its own through a card of the same kind.
        const turnA = mounts.lease("conv-a");
        const TOKEN = turnA.open(card("billing")).token ?? "";
        turnA.open(card("other"));
        const turnB = mounts.lease("conv-b");
        const tokenB = turnB.open(card("payroll")).token ?? "";
        const extensionBackend = {
            proxyTarget: () => ({ port: upstream.port, hostToken: HOST_TOKEN }),
            status: () => ({ state: "running", extensions: [] }),
        } as unknown as ExtensionBackend;
        const extension = createExtensionMcpEndpoint({
            ...host,
            capabilities: { list: async () => capabilities, get: async (id: string) => capabilities.find((entry) => entry.id === id) },
            extensionBackend,
        } as unknown as Parameters<typeof createExtensionMcpEndpoint>[0]);
        const route = createTurnMountRoute(mounts, unstubbed<MountEndpoints>("endpoints", { extension }));
        const app = new Hono<AppEnv>().all("/mcp/:mount", route);
        const post = (id: string, token: string) =>
            app.request(`/mcp/${id}?probe=1`, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: "{}" });

        expect((await post("billing", "wrong")).status).toBe(401);
        expect((await post("other", TOKEN)).status).toBe(404);
        expect((await post("missing", TOKEN)).status).toBe(403);
        // A valid bearer from turn B cannot call a card turn B was not granted, whatever the path names.
        expect((await post("billing", tokenB)).status).toBe(403);
        expect(upstream.seen).toEqual([]);

        const answered = await post("billing", TOKEN);
        expect(answered.status).toBe(200);
        expect(upstream.seen).toHaveLength(1);
        expect(upstream.seen[0]?.url).toBe("/x/test.acme/mcp/billing?probe=1");
        expect(upstream.seen[0]?.headers?.["x-intentic-backend"]).toBe(HOST_TOKEN);
        expect(upstream.seen[0]?.headers?.["authorization"]).toBeUndefined();
        // The card's settings as the daemon holds them now, so the backend need not read them back.
        const handed = String(upstream.seen[0]?.headers?.["x-intentic-card"] ?? "");
        expect(JSON.parse(Buffer.from(handed, "base64url").toString("utf8"))).toEqual({ id: "billing", config: { provider: "acme", token: "t" } });

        // Once turn A ends, its bearer is forgotten and opens nothing, the card it was granted included.
        turnA.release();
        expect((await post("billing", TOKEN)).status).toBe(401);
        expect(upstream.seen).toHaveLength(1);
    } finally {
        upstream.server.close();
    }
});
