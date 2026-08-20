#!/usr/bin/env node
// browser-router <manifest.json> — ONE stdio MCP server standing in for every signed-in browser a turn may
// drive. The harness used to mount one @playwright/mcp server per connected account, which cost twice: every
// turn started one process per account before the agent said a word (solved once by a socket mux), and every
// account pinned its own copy of ~21 tool schemas into the prompt — the schemas multiplied even after the
// processes stopped doing so. This process is the schema fix and the process fix in one shape: the harness
// spawns it as the single server `browser`, its tools each take an `account` parameter, and the real
// per-profile @playwright/mcp backend is spawned lazily on the first call that names it.
//
// initialize and tools/list are answered locally from a version-keyed schema cache (probed once per
// @playwright/mcp version from a throwaway isolated server), with `account` injected into every tool's input
// schema. A tools/call resolves `account` through the manifest — account ids and identity ids alike map to the
// PROFILE OWNER, because an identity and every account born from it are one browser — strips the parameter,
// and pipes the call to that owner's backend. An id the manifest does not carry is refused with the granted
// set named: the manifest is built from the persona-filtered capability list, so this refusal IS the
// enforcement, and it reads as an answer rather than as a tool that mysteriously does not exist.
//
// LIFECYCLE: a direct child of the harness, like any stdio MCP server — stdin closing is the turn ending, and
// the backends are children of this process that are killed on the way out. No sockets, no bridges, no idle
// timers: the process tree is the lifecycle.
//
// The wire protocol is stdio MCP verbatim (newline-delimited JSON-RPC). After a backend is up its pipe is
// nearly transparent; the only messages this process keeps parsing are the ones it must route — client
// requests to the right backend, and the rare backend-initiated request back out under a prefixed id so two
// backends' own ids can never collide on the shared client.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const manifestPath = process.argv[2];
if (manifestPath === undefined) {
    console.error("browser-router: no manifest given");
    process.exit(2);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
// { schemaCachePath, probe: {command, args}, accounts: { <account-or-identity-id>: <owner> },
//   owners: { <owner>: { command, args, env } } }

const PROBE_TIMEOUT_MS = 30_000;
// The id namespace for requests a BACKEND initiates toward the client — prefixed so ids minted independently
// by two backends stay distinct on the shared wire, and so the client's answer can be routed home.
const BACKEND_ID_PREFIX = "browser-router:";

// ---- newline-delimited JSON-RPC framing, shared by the client pipe and the backend pipes -------------------
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
const toClient = (message) => send(process.stdout, message);

const backends = new Map(); // owner → { child, ready, queue: string[], nextId: number }

const shutdown = (code) => {
    for (const backend of backends.values()) {
        backend.child?.kill("SIGTERM");
    }
    process.exit(code);
};
process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));

// ---- the tool schemas, probed once per @playwright/mcp version and cached for every later router -----------
let schemaPromise;
const toolSchemas = () => {
    schemaPromise ??= (async () => {
        try {
            return JSON.parse(readFileSync(manifest.schemaCachePath, "utf8"));
        } catch {
            // First router of this version: derive from a throwaway isolated server. Racing routers both probe
            // and both write — the rename is atomic and the contents identical, so last-writer-wins is harmless.
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
                if (message.id === "router-probe-init") {
                    send(probe.stdin, { jsonrpc: "2.0", id: "router-probe-tools", method: "tools/list", params: {} });
                } else if (message.id === "router-probe-tools") {
                    clearTimeout(timer);
                    probe.kill("SIGTERM");
                    resolve(message.result?.tools ?? []);
                }
            }),
        );
        send(probe.stdin, {
            jsonrpc: "2.0",
            id: "router-probe-init",
            method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "intentic-browser-router", version: "1.0.0" } },
        });
        send(probe.stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    });

/* Every tool gains the parameter that says WHOSE browser — required, because a call that names nobody would
 * have this process guessing between signed-in profiles, which is the wrong-account mistake the parameter
 * exists to prevent. The granted ids are deliberately NOT enumerated per tool (that would re-multiply the very
 * schemas this process exists to collapse once per account); the skills and the roster tool carry them. */
const ACCOUNT_PROPERTY = {
    type: "string",
    description:
        "Which account to act as — a connected account's capability id, or an identity's id for its own browser. " +
        "The account skills and `mcp__accounts__roster` name the ones this sandbox holds.",
};
const withAccountParameter = (tools) =>
    tools.map((tool) => {
        const schema = tool.inputSchema ?? { type: "object", properties: {} };
        return {
            ...tool,
            inputSchema: {
                ...schema,
                properties: { ...schema.properties, account: ACCOUNT_PROPERTY },
                required: [...(schema.required ?? []), "account"],
            },
        };
    });

// ---- one owner's lazily-spawned real server -----------------------------------------------------------------
const backendFor = (owner) => {
    const existing = backends.get(owner);
    if (existing !== undefined) {
        return existing;
    }
    const spec = manifest.owners[owner];
    const child = spawn(spec.command, spec.args, {
        env: { ...process.env, ...spec.env },
        stdio: ["pipe", "pipe", "ignore"],
    });
    const backend = { child, ready: false, queue: [], nextId: 1 };
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
            let message;
            try {
                message = JSON.parse(line);
            } catch {
                return;
            }
            // The reply to the replayed handshake is this process's own business.
            if (message.id === "router-init" && message.result !== undefined) {
                backend.ready = true;
                for (const queued of backend.queue.splice(0)) {
                    child.stdin.write(`${queued}\n`);
                }
                return;
            }
            // A request the BACKEND initiates (elicitation, sampling): re-minted under a prefixed id so two
            // backends can never collide on the shared client, and so the answer routes home (below).
            if (message.method !== undefined && message.id !== undefined) {
                const outbound = `${BACKEND_ID_PREFIX}${owner}:${backend.nextId}`;
                backend.nextId += 1;
                backendRequests.set(outbound, { owner, id: message.id });
                toClient({ ...message, id: outbound });
                return;
            }
            // Responses to the client's own calls (their ids are the client's, unique across backends because
            // one client minted them all) and notifications pass through verbatim.
            toClient(message);
        }),
    );
    // Replay the handshake this process already answered, so the backend joins the conversation mid-sentence
    // believing it started it. The client's own initialize params ride along — protocol version included.
    send(child.stdin, {
        jsonrpc: "2.0",
        id: "router-init",
        method: "initialize",
        params: clientInitializeParams ?? {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "intentic-browser-router", version: "1.0.0" },
        },
    });
    send(child.stdin, { jsonrpc: "2.0", method: "notifications/initialized" });
    return backend;
};

const forward = (backend, message) => {
    const line = JSON.stringify(message);
    if (backend.ready) {
        backend.child.stdin.write(`${line}\n`);
    } else {
        backend.queue.push(line);
    }
};

// ---- the client side ----------------------------------------------------------------------------------------
let clientInitializeParams;
const callRoutes = new Map(); // client request id → owner, so cancellations chase their call
const backendRequests = new Map(); // prefixed id → { owner, id }, so a client answer routes home

const refusal = (id, account) =>
    toClient({
        jsonrpc: "2.0",
        id,
        result: {
            content: [
                {
                    type: "text",
                    text:
                        account === undefined
                            ? `this call names no account — pass \`account\` (granted this turn: ${Object.keys(manifest.accounts).join(", ")})`
                            : `no account "${account}" this turn can act as — granted: ${Object.keys(manifest.accounts).join(", ")}. ` +
                              `An account opened this turn lives in its identity's browser — pass the identity's id.`,
                },
            ],
            isError: true,
        },
    });

process.stdin.on(
    "data",
    lineReader((line) => {
        let message;
        try {
            message = JSON.parse(line);
        } catch {
            return;
        }
        // The client answering a backend-initiated request: strip the prefix and route it home.
        if (message.method === undefined && typeof message.id === "string" && message.id.startsWith(BACKEND_ID_PREFIX)) {
            const route = backendRequests.get(message.id);
            backendRequests.delete(message.id);
            const backend = route === undefined ? undefined : backends.get(route.owner);
            if (backend !== undefined) {
                forward(backend, { ...message, id: route.id });
            }
            return;
        }
        if (message.method === "initialize") {
            clientInitializeParams = message.params;
            toClient({
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
        if (message.method === "notifications/initialized") {
            return;
        }
        if (message.method === "notifications/cancelled") {
            const owner = callRoutes.get(message.params?.requestId);
            const backend = owner === undefined ? undefined : backends.get(owner);
            if (backend !== undefined) {
                forward(backend, message);
            }
            return;
        }
        if (message.method === "ping") {
            toClient({ jsonrpc: "2.0", id: message.id, result: {} });
            return;
        }
        if (message.method === "tools/list") {
            void toolSchemas().then(
                (tools) => toClient({ jsonrpc: "2.0", id: message.id, result: { tools: withAccountParameter(tools) } }),
                (error) =>
                    toClient({
                        jsonrpc: "2.0",
                        id: message.id,
                        error: { code: -32603, message: `browser tools unavailable: ${error?.message ?? error}` },
                    }),
            );
            return;
        }
        if (message.method === "tools/call") {
            const { account, ...rest } = message.params?.arguments ?? {};
            const owner = typeof account === "string" ? manifest.accounts[account] : undefined;
            if (owner === undefined || manifest.owners[owner] === undefined) {
                refusal(message.id, typeof account === "string" ? account : undefined);
                return;
            }
            callRoutes.set(message.id, owner);
            // Bounded by forgetting settled routes opportunistically: a route only matters while its call is
            // in flight, and the map would otherwise grow by one entry per browser action for the whole turn.
            if (callRoutes.size > 512) {
                for (const key of [...callRoutes.keys()].slice(0, 256)) {
                    callRoutes.delete(key);
                }
            }
            forward(backendFor(owner), { ...message, params: { ...message.params, arguments: rest } });
            return;
        }
        // Anything else is a question only a specific backend could answer, and nothing here says which one.
        if (message.id !== undefined) {
            toClient({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unsupported method "${message.method}"` } });
        }
    }),
);

// The turn ending closes stdin — the browsers behind this process have nobody left to drive them.
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));
