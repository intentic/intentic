import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The router's contract, driven over real stdio against real child processes:
// 1. handshake and tools/list are answered with no backend and no daemon round trip; every listed tool gains an
//    injected `account` parameter.
// 2. a tool call resolves `account` to its owner, asks the daemon for that owner's spawn spec once, spawns it, strips
//    the parameter, and pipes back the reply.
// 3. an id outside the manifest is refused with the granted set named, and asks the daemon nothing.
// 4. a daemon that refuses an owner turns into a tool error, not a dead pipe.
// 5. a sole-owner manifest serves tools with no `account` at all and routes everything to that owner.
// 6. stdin closing kills the backends.
// The backend is a canary standing in for @playwright/mcp; it writes a marker file on spawn and echoes call arguments
// back. The daemon is a real loopback server standing in for /system/browser/prepare.

const ROUTER = fileURLToPath(new URL("../../bin/browser-router.mjs", import.meta.url));

const CANARY = `
const fs = require("fs");
const marker = process.argv[2];
fs.writeFileSync(marker, String(process.pid));
process.on("SIGTERM", () => { fs.unlinkSync(marker); process.exit(0); });
let buffer = "";
process.stdin.on("data", (chunk) => {
    buffer += chunk.toString();
    let at;
    while ((at = buffer.indexOf("\\n")) !== -1) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 1);
        if (!line.trim()) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\\n");
        if (msg.method === "initialize") reply({ protocolVersion: msg.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "canary", version: "1.0.0" } });
        else if (msg.method === "tools/list") reply({ tools: [{ name: "browser_probe", description: "canary tool", inputSchema: { type: "object", properties: {} } }] });
        else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: "echo:" + marker + ":" + JSON.stringify(msg.params?.arguments ?? {}) }] });
        else if (msg.id !== undefined) reply({});
    }
});
`;

interface Harness {
    readonly dir: string;
    readonly markers: Record<string, string>;
    readonly schemaCachePath: string;
    readonly router: ChildProcess;
    // Owners the router asked the daemon to bring up, in order: the record that proves what was paid for and when.
    readonly prepares: string[];
    // Owners the stand-in daemon refuses instead of handing back a spec.
    readonly refusals: Map<string, string>;
}

const PREPARE_TOKEN = "test-bridge-token";

// Stands in for the daemon's prepare route: same bearer, same two answer shapes.
const startPrepareDaemon = (
    canaryPath: string,
    markers: Record<string, string>,
    prepares: string[],
    refusals: Map<string, string>,
): Promise<{ readonly url: string; readonly server: Server }> => {
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
            body += chunk.toString();
        });
        request.on("end", () => {
            if (request.headers.authorization !== `Bearer ${PREPARE_TOKEN}`) {
                response.writeHead(401).end("{}");
                return;
            }
            const owner = (JSON.parse(body) as { owner: string }).owner;
            prepares.push(owner);
            const refusal = refusals.get(owner);
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
                JSON.stringify(
                    refusal === undefined ? { command: process.execPath, args: [canaryPath, markers[owner]], env: { ...process.env } } : { refusal },
                ),
            );
        });
    });
    return new Promise((resolve) => {
        server.listen(0, "127.0.0.1", () => {
            resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/prepare`, server });
        });
    });
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
        await cleanup();
    }
});

const startRouter = async (soleOwner?: string): Promise<Harness> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-router-test-"));
    const canaryPath = join(dir, "canary.cjs");
    await writeFile(canaryPath, CANARY);
    const markers =
        soleOwner === undefined
            ? { "identity-1": join(dir, "identity-1.pid"), standalone: join(dir, "standalone.pid") }
            : { [soleOwner]: join(dir, `${soleOwner}.pid`) };
    const probeMarker = join(dir, "probe.pid");
    const schemaCachePath = join(dir, "tools.json");
    const prepares: string[] = [];
    const refusals = new Map<string, string>();
    const daemon = await startPrepareDaemon(canaryPath, markers, prepares, refusals);
    const manifest = {
        schemaCachePath,
        probe: { command: process.execPath, args: [canaryPath, probeMarker] },
        // Two accounts of one identity plus the identity itself share a backend; a standalone owns its own.
        accounts: soleOwner === undefined ? { "identity-1": "identity-1", "born-acct": "identity-1", standalone: "standalone" } : {},
        // A port per owner, reserved by the turn; the spec the daemon hands back is pinned to it.
        owners: Object.fromEntries(Object.keys(markers).map((owner, index) => [owner, { port: 41_000 + index }])),
        prepare: { url: daemon.url, token: PREPARE_TOKEN },
        backendEnv: {},
        ...(soleOwner === undefined ? {} : { soleOwner }),
    };
    const manifestPath = join(dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const router = spawn(process.execPath, [ROUTER, manifestPath], { stdio: ["pipe", "pipe", "inherit"] });
    cleanups.push(async () => {
        router.kill("SIGKILL");
        await new Promise((resolve) => daemon.server.close(resolve));
        await rm(dir, { recursive: true, force: true });
    });
    return { dir, markers, schemaCachePath, router, prepares, refusals };
};

// One JSON-RPC exchange over the router's stdio: send, await the response carrying the same id.
const rpc = (router: ChildProcess, message: Record<string, unknown>): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
        let buffer = "";
        const onData = (chunk: Buffer): void => {
            buffer += chunk.toString();
            let at;
            while ((at = buffer.indexOf("\n")) !== -1) {
                const line = buffer.slice(0, at);
                buffer = buffer.slice(at + 1);
                if (!line.trim()) {
                    continue;
                }
                const parsed = JSON.parse(line) as Record<string, unknown>;
                if (parsed["id"] === message["id"]) {
                    router.stdout?.off("data", onData);
                    clearTimeout(timer);
                    resolve(parsed);
                    return;
                }
            }
        };
        const timer = setTimeout(() => {
            router.stdout?.off("data", onData);
            reject(new Error(`no response to ${String(message["method"])}`));
        }, 10_000);
        router.stdout?.on("data", onData);
        router.stdin?.write(`${JSON.stringify(message)}\n`);
    });

const handshake = async (harness: Harness): Promise<void> => {
    await rpc(harness.router, {
        jsonrpc: "2.0",
        id: "init",
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    harness.router.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
};

const exists = async (path: string): Promise<boolean> =>
    readFile(path)
        .then(() => true)
        .catch(() => false);

interface ToolResult {
    content: { text: string }[];
    isError?: boolean;
}

test("handshake and tools/list cost no backend, and every tool gains the required account parameter", async () => {
    const harness = await startRouter();
    await handshake(harness);
    const list = await rpc(harness.router, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const tools = (list["result"] as { tools: { name: string; inputSchema: { properties: Record<string, unknown>; required: string[] } }[] }).tools;
    expect(tools.map((tool) => tool.name)).toEqual(["browser_probe"]);
    expect(tools[0]?.inputSchema.properties["account"]).toMatchObject({ type: "string" });
    expect(tools[0]?.inputSchema.required).toContain("account");
    expect(await exists(harness.markers["identity-1"] as string)).toBe(false);
    expect(await exists(harness.markers["standalone"] as string)).toBe(false);
    // The point of the whole arrangement: a client can learn every browser tool without this sandbox starting a
    // display, dialling an exit or launching Chromium for any of them.
    expect(harness.prepares).toEqual([]);
    // Schema cache is unmutated by the probe; the account parameter is injected on the way out, not into the cache.
    expect(JSON.parse(await readFile(harness.schemaCachePath, "utf8"))).toEqual([
        { name: "browser_probe", description: "canary tool", inputSchema: { type: "object", properties: {} } },
    ]);
});

test("a call routes by account to the owner's backend with the parameter stripped; an identity-born account shares it", async () => {
    const harness = await startRouter();
    await handshake(harness);
    const call = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "born-acct", url: "https://example.com" } },
    });
    const echoed = (call["result"] as ToolResult).content[0]?.text ?? "";
    expect(echoed).toContain(harness.markers["identity-1"] as string);
    expect(echoed).toContain('{"url":"https://example.com"}');
    expect(await exists(harness.markers["identity-1"] as string)).toBe(true);
    expect(await exists(harness.markers["standalone"] as string)).toBe(false);

    const other = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "standalone" } },
    });
    expect((other["result"] as ToolResult).content[0]?.text).toContain(harness.markers["standalone"] as string);
    expect(await exists(harness.markers["standalone"] as string)).toBe(true);
});

test("an account outside the manifest is refused with the granted set named, and no backend pays for it", async () => {
    const harness = await startRouter();
    await handshake(harness);
    const denied = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 5,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "reddit-personal" } },
    });
    const result = denied["result"] as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('"reddit-personal"');
    expect(result.content[0]?.text).toContain("identity-1");
    expect(result.content[0]?.text).toContain("standalone");

    const missing = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "browser_probe", arguments: {} },
    });
    expect((missing["result"] as ToolResult).isError).toBe(true);
    expect(await exists(harness.markers["identity-1"] as string)).toBe(false);
    expect(await exists(harness.markers["standalone"] as string)).toBe(false);
    expect(harness.prepares).toEqual([]);
});

test("the turn ending, stdin closing: kills the backends", async () => {
    const harness = await startRouter();
    await handshake(harness);
    await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "identity-1" } },
    });
    expect(await exists(harness.markers["identity-1"] as string)).toBe(true);
    harness.router.stdin?.end();
    for (let waited = 0; (await exists(harness.markers["identity-1"] as string)) && waited < 5_000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // SIGTERM: the canary unlinks its marker on the way out.
    expect(await exists(harness.markers["identity-1"] as string)).toBe(false);
});

test("a second turn's router answers tools/list straight from the cache: no probe, no backend", async () => {
    const first = await startRouter();
    await handshake(first);
    await rpc(first.router, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    first.router.stdin?.end();

    const second = await startRouter();
    await writeFile(second.schemaCachePath, await readFile(first.schemaCachePath, "utf8"));
    await handshake(second);
    const list = await rpc(second.router, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect((list["result"] as { tools: unknown[] }).tools).toHaveLength(1);
    expect(await exists(join(second.dir, "probe.pid"))).toBe(false);
});

test("an owner is prepared once, on its first call, however many calls name it", async () => {
    const harness = await startRouter();
    await handshake(harness);
    expect(harness.prepares).toEqual([]);
    // Sent together, deliberately: two racing first calls must not spawn two Chromiums on one profile.
    const [first, second] = await Promise.all([
        rpc(harness.router, { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "browser_probe", arguments: { account: "identity-1" } } }),
        rpc(harness.router, { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "browser_probe", arguments: { account: "born-acct" } } }),
    ]);
    expect((first["result"] as ToolResult).isError).toBeUndefined();
    expect((second["result"] as ToolResult).isError).toBeUndefined();
    await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "identity-1" } },
    });
    expect(harness.prepares).toEqual(["identity-1"]);
});

test("an owner the daemon refuses comes back as a tool error naming why, and nothing is spawned", async () => {
    const harness = await startRouter();
    harness.refusals.set("standalone", 'standalone browses through the exit "berlin", which is down.');
    await handshake(harness);
    const denied = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 11,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "standalone" } },
    });
    const result = denied["result"] as ToolResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("berlin");
    expect(await exists(harness.markers["standalone"] as string)).toBe(false);
    // Not remembered as refused: the exit can come up inside the same turn.
    harness.refusals.delete("standalone");
    const retried = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 12,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { account: "standalone" } },
    });
    expect((retried["result"] as ToolResult).isError).toBeUndefined();
    expect(await exists(harness.markers["standalone"] as string)).toBe(true);
});

test("a sole-owner router declares no account parameter and routes every call to its one owner", async () => {
    const harness = await startRouter("web");
    await handshake(harness);
    const list = await rpc(harness.router, { jsonrpc: "2.0", id: 13, method: "tools/list", params: {} });
    const tools = (list["result"] as { tools: { inputSchema: { properties: Record<string, unknown>; required?: string[] } }[] }).tools;
    expect(tools[0]?.inputSchema.properties["account"]).toBeUndefined();
    expect(tools[0]?.inputSchema.required ?? []).not.toContain("account");
    expect(harness.prepares).toEqual([]);
    const call = await rpc(harness.router, {
        jsonrpc: "2.0",
        id: 14,
        method: "tools/call",
        params: { name: "browser_probe", arguments: { url: "https://example.com" } },
    });
    expect((call["result"] as ToolResult).content[0]?.text).toContain('{"url":"https://example.com"}');
    expect(harness.prepares).toEqual(["web"]);
    expect(await exists(harness.markers["web"] as string)).toBe(true);
});
