import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test } from "vitest";

/* The mux's whole contract, driven over a real socket against real child processes:
 *
 *   1. the handshake and the tool list are answered WITHOUT a backend — the entire point, since the harness
 *      asks both of every server at startup whether or not the turn ever browses;
 *   2. the first real tool call spawns the backend, replays the handshake, and pipes the answer back verbatim;
 *   3. the bridge closing (the turn ending) kills the backend.
 *
 * The backend is a canary script standing in for @playwright/mcp: same wire protocol, and it writes a marker
 * file on spawn — the file IS the assertion that lazy means lazy. */

const MUX = fileURLToPath(new URL("../../bin/browser-mux.mjs", import.meta.url));

// A stdio MCP server that records its spawn and its death, answers the handshake, lists one tool, and echoes
// tool calls — everything the mux forwards can be asserted from what comes back.
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
        else if (msg.method === "tools/call") reply({ content: [{ type: "text", text: "echo:" + (msg.params?.name ?? "?") }] });
        else if (msg.id !== undefined) reply({});
    }
});
`;

interface Harness {
    readonly dir: string;
    readonly socket: string;
    readonly marker: string;
    readonly schemaCachePath: string;
    readonly mux: ChildProcess;
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
        await cleanup();
    }
});

const startMux = async (): Promise<Harness> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-mux-test-"));
    const canaryPath = join(dir, "canary.cjs");
    await writeFile(canaryPath, CANARY);
    const socket = join(dir, "owner.sock");
    const marker = join(dir, "backend.pid");
    const probeMarker = join(dir, "probe.pid");
    const schemaCachePath = join(dir, "tools.json");
    const manifest = {
        schemaCachePath,
        probe: { command: process.execPath, args: [canaryPath, probeMarker] },
        owners: { "acct-1": { socket, command: process.execPath, args: [canaryPath, marker], env: {} } },
    };
    const manifestPath = join(dir, "manifest.json");
    await writeFile(manifestPath, JSON.stringify(manifest));
    const mux = spawn(process.execPath, [MUX, manifestPath], { stdio: ["ignore", "ignore", "inherit"] });
    cleanups.push(async () => {
        mux.kill("SIGKILL");
        await rm(dir, { recursive: true, force: true });
    });
    // The listeners appear as socket files in the mux's first synchronous pass.
    for (let waited = 0; waited < 5_000; waited += 25) {
        try {
            await readFile(manifestPath);
            const probe = net.connect(socket);
            const opened = await new Promise<boolean>((resolve) => {
                probe.once("connect", () => resolve(true));
                probe.once("error", () => resolve(false));
            });
            probe.destroy();
            if (opened) {
                break;
            }
        } catch {
            // Not up yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return { dir, socket, marker, schemaCachePath, mux };
};

// One JSON-RPC exchange over the socket: send, await the response carrying the same id.
const rpc = (socket: net.Socket, message: Record<string, unknown>): Promise<Record<string, unknown>> =>
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
                    socket.off("data", onData);
                    clearTimeout(timer);
                    resolve(parsed);
                    return;
                }
            }
        };
        const timer = setTimeout(() => {
            socket.off("data", onData);
            reject(new Error(`no response to ${String(message["method"])}`));
        }, 10_000);
        socket.on("data", onData);
        socket.write(`${JSON.stringify(message)}\n`);
    });

const connect = (path: string): Promise<net.Socket> =>
    new Promise((resolve, reject) => {
        const socket = net.connect(path);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
    });

const exists = async (path: string): Promise<boolean> =>
    readFile(path)
        .then(() => true)
        .catch(() => false);

test("handshake and tools/list are answered with no backend; the first tool call spawns it; closing kills it", async () => {
    const harness = await startMux();
    const client = await connect(harness.socket);

    const init = await rpc(client, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    expect((init["result"] as { serverInfo: { name: string } }).serverInfo.name).toBe("intentic-browser");
    client.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);

    const list = await rpc(client, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect((list["result"] as { tools: { name: string }[] }).tools.map((tool) => tool.name)).toEqual(["browser_probe"]);
    // The whole point: the startup questions cost no browser process.
    expect(await exists(harness.marker)).toBe(false);
    // …but the schema had to come from somewhere: the probe ran once and its answer is cached for every
    // later mux of this version.
    expect(JSON.parse(await readFile(harness.schemaCachePath, "utf8"))).toEqual([
        { name: "browser_probe", description: "canary tool", inputSchema: { type: "object", properties: {} } },
    ]);

    const call = await rpc(client, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "browser_probe", arguments: {} } });
    expect((call["result"] as { content: { text: string }[] }).content[0]?.text).toBe("echo:browser_probe");
    expect(await exists(harness.marker)).toBe(true);

    // The turn ends: the bridge closes, and the backend goes with it (SIGTERM — the canary unlinks its marker).
    client.destroy();
    for (let waited = 0; (await exists(harness.marker)) && waited < 5_000; waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(await exists(harness.marker)).toBe(false);
});

test("a second turn's mux answers tools/list straight from the cache — no probe, no backend", async () => {
    const first = await startMux();
    const client = await connect(first.socket);
    await rpc(client, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    await rpc(client, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    client.destroy();

    // Second mux, same cache path: hand it the first one's cache and a probe that CANNOT run.
    const second = await startMux();
    await writeFile(second.schemaCachePath, await readFile(first.schemaCachePath, "utf8"));
    const manifest = JSON.parse(await readFile(join(second.dir, "manifest.json"), "utf8")) as { probe: { command: string } };
    expect(manifest.probe.command).toBeTruthy();
    const client2 = await connect(second.socket);
    await rpc(client2, {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } },
    });
    const list = await rpc(client2, { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    expect((list["result"] as { tools: unknown[] }).tools).toHaveLength(1);
    // No backend and no probe ran for the second mux.
    expect(await exists(second.marker)).toBe(false);
    expect(await exists(join(second.dir, "probe.pid"))).toBe(false);
    client2.destroy();
});
