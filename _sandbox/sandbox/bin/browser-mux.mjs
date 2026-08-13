#!/usr/bin/env node
// browser-mux <manifest.json> — one small process standing in for a turn's WHOLE FLEET of account-browser
// MCP servers, so none of them exists until the agent actually drives one.
//
// The harness connects to every configured stdio MCP server at startup and asks two questions — initialize and
// tools/list — whether or not the turn will ever use it (verified against the real binary: a DEFERRED server is
// spawned and handshaken at startup too; deferral only keeps its schemas out of the prompt). With one
// node+playwright process per connected account, that made every turn start ~30 processes and ~3.5 GB before
// the agent had said a word, multiplied by every concurrently-running agent — the single largest memory load on
// the sandbox, almost all of it for browsers nobody would touch.
//
// So the per-account server the harness spawns is now a ~1 MB socat bridge into THIS process (one per turn,
// spawned by the daemon — src/browser/browser-tools.ts), and this process answers the cheap questions itself:
// initialize and tools/list are served from a version-keyed schema cache, no browser anywhere. Only a REAL tool
// call spawns that one account's actual @playwright/mcp server (which launches its Chromium lazily in turn),
// and from then on the wire is a transparent pipe. The schema cache is derived once per @playwright/mcp version
// by probing a throwaway isolated server, then shared by every mux from disk.
//
// LIFECYCLE, deliberately boring: this process is a stamped child of the daemon, so the reaper's ordinary rules
// already own it (platform/reaper.ts); backends are ITS children and die with their client connection — the
// turn ending closes the socat bridges, which is the signal to kill what they were bridging to. A mux nothing
// ever connected to times itself out.
//
// The wire protocol is stdio MCP verbatim (newline-delimited JSON-RPC), which is what makes the bridge a plain
// byte pipe: nothing here parses a message after the backend is up, except to drop the replies to its own
// replayed handshake.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import net from "node:net";
import { dirname } from "node:path";

const manifestPath = process.argv[2];
if (manifestPath === undefined) {
    console.error("browser-mux: no manifest given");
    process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// { schemaCachePath, probe: {command, args}, owners: { <owner>: { socket, command, args, env } } }

// A turn nobody connected to (the provider failed before its MCP startup) must not linger as a listener
// forever; once anybody HAS connected, exit is driven by the last connection closing instead.
const IDLE_EXIT_MS = 10 * 60_000;
// The last bridge closed — the turn is over. A short grace covers the harness reconnecting a server it
// restarts mid-turn, which is rare but real.
const LINGER_MS = 15_000;
const PROBE_TIMEOUT_MS = 30_000;

let everConnected = false;
let openConnections = 0;
let lingerTimer;
const idleTimer = setTimeout(() => {
    if (!everConnected) {
        shutdown(0);
    }
}, IDLE_EXIT_MS);
idleTimer.unref();

const backends = new Map(); // owner → { child, ready, queue: string[] }

const shutdown = (code) => {
    for (const backend of backends.values()) {
        backend.child?.kill("SIGTERM");
    }
    for (const owner of Object.keys(manifest.owners)) {
        try {
            unlinkSync(manifest.owners[owner].socket);
        } catch {
            // Already gone — the goal either way.
        }
    }
    process.exit(code);
};
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// ---- newline-delimited JSON-RPC framing, shared by the client sockets and the backend pipes ----------------
const lineReader = (onLine) => {
    let buffer = "";
    return (chunk) => {
        buffer += chunk.toString("utf8");
        let at;
        while ((at = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            if (line.trim() !== "") {
                onLine(line);
            }
        }
    };
};
const send = (stream, message) => {
    try {
        stream.write(`${JSON.stringify(message)}\n`);
    } catch {
        // The other side went away mid-write; its close handler owns the consequences.
    }
};

// ---- the tool schema, probed once per @playwright/mcp version and cached for every later mux ---------------
let schemaPromise;
const toolSchemas = () => {
    schemaPromise ??= (async () => {
        try {
            return JSON.parse(readFileSync(manifest.schemaCachePath, "utf8"));
        } catch {
            // First mux of this version: derive from a throwaway isolated server. Racing muxes both probe and
            // both write — the rename is atomic and the contents identical, so last-writer-wins is harmless.
        }
        const tools = await probeTools();
        try {
            mkdirSync(dirname(manifest.schemaCachePath), { recursive: true });
            const temp = `${manifest.schemaCachePath}.${process.pid}.tmp`;
            writeFileSync(temp, JSON.stringify(tools));
            renameSync(temp, manifest.schemaCachePath);
        } catch {
            // Cache miss next time costs one more probe; the answer this turn is already in hand.
        }
        return tools;
    })();
    return schemaPromise;
};

const probeTools = () =>
    new Promise((resolve, reject) => {
        const probe = spawn(manifest.probe.command, manifest.probe.args, { stdio: ["pipe", "pipe", "ignore"] });
        const timer = setTimeout(() => {
            probe.kill("SIGKILL");
            reject(new Error("schema probe timed out"));
        }, PROBE_TIMEOUT_MS);
        probe.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        probe.stdout.on(
            "data",
            lineReader((line) => {
                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    return;
                }
                if (message.id === "mux-probe-init") {
                    send(probe.stdin, { jsonrpc: "2.0", id: "mux-probe-tools", method: "tools/list", params: {} });
                } else if (message.id === "mux-probe-tools") {
                    clearTimeout(timer);
                    probe.kill("SIGTERM");
                    resolve(message.result?.tools ?? []);
                }
            }),
        );
        send(probe.stdin, {
            jsonrpc: "2.0",
            id: "mux-probe-init",
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "intentic-browser-mux", version: "1.0.0" } },
        });
        send(probe.stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    });

// ---- one account's lazily-spawned real server -----------------------------------------------------------------
const backendFor = (owner, initializeParams, socket) => {
    const existing = backends.get(owner);
    if (existing !== undefined) {
        return existing;
    }
    const spec = manifest.owners[owner];
    const child = spawn(spec.command, spec.args, {
        env: { ...process.env, ...spec.env },
        stdio: ["pipe", "pipe", "ignore"],
    });
    const backend = { child, ready: false, queue: [] };
    backends.set(owner, backend);
    child.on("error", () => {
        backends.delete(owner);
    });
    child.on("exit", () => {
        backends.delete(owner);
    });
    child.stdout.on(
        "data",
        lineReader((line) => {
            // The replies to the replayed handshake are the mux's own business; everything else — responses,
            // notifications, server-initiated requests — belongs to the client verbatim.
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                return;
            }
            if (message.id === "mux-init") {
                backend.ready = true;
                for (const queued of backend.queue.splice(0)) {
                    child.stdin.write(`${queued}\n`);
                }
                return;
            }
            try {
                socket.write(`${line}\n`);
            } catch {
                // Client gone; the socket close handler is tearing this backend down.
            }
        }),
    );
    // Replay the handshake the mux already answered, so the backend joins the conversation mid-sentence
    // believing it started it. The client's own initialize params ride along — protocol version included.
    send(child.stdin, {
        jsonrpc: "2.0",
        id: "mux-init",
        method: "initialize",
        params: initializeParams ?? {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "intentic-browser-mux", version: "1.0.0" },
        },
    });
    send(child.stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    return backend;
};

// ---- the per-account listeners the socat bridges dial ------------------------------------------------------
for (const [owner, spec] of Object.entries(manifest.owners)) {
    try {
        unlinkSync(spec.socket);
    } catch {
        // Fresh path in the common case.
    }
    const server = net.createServer((socket) => {
        everConnected = true;
        openConnections += 1;
        if (lingerTimer !== undefined) {
            clearTimeout(lingerTimer);
            lingerTimer = undefined;
        }
        let initializeParams;
        socket.on(
            "data",
            lineReader((line) => {
                let message;
                try {
                    message = JSON.parse(line);
                } catch {
                    return;
                }
                const backend = backends.get(owner);
                if (backend !== undefined) {
                    // Past the handshake and a backend exists: transparent pipe, queued while it boots.
                    if (backend.ready) {
                        backend.child.stdin.write(`${line}\n`);
                    } else {
                        backend.queue.push(line);
                    }
                    return;
                }
                if (message.method === "initialize") {
                    initializeParams = message.params;
                    send(socket, {
                        jsonrpc: "2.0",
                        id: message.id,
                        result: {
                            protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
                            capabilities: { tools: {} },
                            serverInfo: { name: "intentic-browser", version: "1.0.0" },
                        },
                    });
                    return;
                }
                if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
                    return;
                }
                if (message.method === "ping") {
                    send(socket, { jsonrpc: "2.0", id: message.id, result: {} });
                    return;
                }
                if (message.method === "tools/list") {
                    void toolSchemas().then(
                        (tools) => send(socket, { jsonrpc: "2.0", id: message.id, result: { tools } }),
                        (error) =>
                            send(socket, {
                                jsonrpc: "2.0",
                                id: message.id,
                                error: { code: -32603, message: `browser tools unavailable: ${error?.message ?? error}` },
                            }),
                    );
                    return;
                }
                // The first real question — a tools/call, or anything else only the actual server can answer —
                // is the moment the account's browser becomes worth paying for.
                const started = backendFor(owner, initializeParams, socket);
                if (started.ready) {
                    started.child.stdin.write(`${line}\n`);
                } else {
                    started.queue.push(line);
                }
            }),
        );
        const closed = () => {
            openConnections -= 1;
            // The bridge died with its turn — the browser behind it has nobody left to drive it.
            const backend = backends.get(owner);
            if (backend !== undefined) {
                backends.delete(owner);
                backend.child.kill("SIGTERM");
                const hard = setTimeout(() => backend.child.kill("SIGKILL"), 3_000);
                hard.unref();
            }
            if (openConnections === 0) {
                lingerTimer = setTimeout(() => shutdown(0), LINGER_MS);
                lingerTimer.unref();
            }
        };
        socket.on("close", closed);
        socket.on("error", () => socket.destroy());
    });
    server.on("error", (error) => {
        console.error(`browser-mux: listener for ${owner} failed: ${error?.message ?? error}`);
    });
    server.listen(spec.socket);
}
