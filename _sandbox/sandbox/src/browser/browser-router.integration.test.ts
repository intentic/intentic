import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

/* The router's whole contract, driven over real stdio against real child processes:
 *
 *   1. the handshake and the tool list are answered WITHOUT a backend: the entire point, since the harness
 *      asks both of every server at startup whether or not the turn ever browses, and every listed tool
 *      carries the injected `account` parameter;
 *   2. a tool call resolves `account` (account id or identity id) to the profile owner, spawns that owner's
 *      backend, strips the parameter, and pipes the answer back; two owners get two backends;
 *   3. an id outside the manifest is refused with the granted set named: the persona enforcement seam;
 *   4. stdin closing (the turn ending) kills the backends.
 *
 * The backend is a canary script standing in for @playwright/mcp: same wire protocol, and it writes a marker
 * file on spawn: the file IS the assertion that lazy means lazy. It echoes a call's arguments back, which is
 * how the stripping of `account` is asserted from the outside. */

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
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
        await cleanup();
    }
});

const startRouter = async (): Promise<Harness> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-router-test-"));
    const canaryPath = join(dir, "canary.cjs");
    await writeFile(canaryPath, CANARY);
    const markers = { "identity-1": join(dir, "identity-1.pid"), standalone: join(dir, "standalone.pid") };
    const probeMarker = join(dir, "probe.pid");
    const schemaCachePath = join(dir, "tools.json");
    const manifest = {
        schemaCachePath,
        probe: { command: process.execPath, args: [canaryPath, probeMarker] },
        // Two accounts of one identity plus the identity itself share a backend; a standalone owns its own.
        accounts: { "identity-1": "identity-1", "born-acct": "identity-1", standalone: "standalone" },
        owners: {
            "identity-1": { command: process.execPath, args: [canaryPath, markers["identity-1"]], env: {} },
            standalone: { command: process.execPath, args: [canaryPath, markers["standalone"]], env: {} },
        },
    };
    const manifestPath = join(dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const router = spawn(process.execPath, [ROUTER, manifestPath], { stdio: ["pipe", "pipe", "inherit"] });
    cleanups.push(async () => {
        router.kill("SIGKILL");
        await rm(dir, { recursive: true, force: true });
    });
    return { dir, markers, schemaCachePath, router };
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
    // The whole point: the startup questions cost no browser process.
    expect(await exists(harness.markers["identity-1"] as string)).toBe(false);
    expect(await exists(harness.markers["standalone"] as string)).toBe(false);
    // …but the schema had to come from somewhere: the probe ran once and its answer is cached UNMUTATED for
    // every later router of this version: the account parameter is injected on the way out, not into the cache.
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
    // The identity's backend answered, and `account` never reached it.
    expect(echoed).toContain(harness.markers["identity-1"] as string);
    expect(echoed).toContain('{"url":"https://example.com"}');
    expect(await exists(harness.markers["identity-1"] as string)).toBe(true);
    expect(await exists(harness.markers["standalone"] as string)).toBe(false);

    // A second owner named: a second backend, beside the first.
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
