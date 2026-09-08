#!/usr/bin/env node
// browser-router <manifest.json>: one stdio MCP server standing in for every signed-in browser. Each tool takes an
// `account`, resolved through the manifest to an owner whose real backend spawns lazily on first use; an unrecognised
// account is refused. Backends are children of this process: stdin closing ends the turn and kills them.

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
// Prefix for backend-initiated request ids, so two backends' ids can't collide and answers route home.
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
            // First probe for this version: two racing routers may both write, but rename is atomic and contents match,
            // so last-writer-wins is harmless.
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

// Required, so a call can't leave this process guessing the profile. Granted ids are not enumerated per tool, to avoid
// re-multiplying the schemas this process exists to collapse.
const ACCOUNT_PROPERTY = {
    type: "string",
    description:
        "Which account to act as: a connected account's capability id, or an identity's id for its own browser. " +
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
            // Backend-initiated request (elicitation, sampling); re-minted under a prefixed id so backends can't
            // collide.
            if (message.method !== undefined && message.id !== undefined) {
                const outbound = `${BACKEND_ID_PREFIX}${owner}:${backend.nextId}`;
                backend.nextId += 1;
                backendRequests.set(outbound, { owner, id: message.id });
                toClient({ ...message, id: outbound });
                return;
            }
            // Client-originated responses and notifications pass through verbatim; their ids are already unique.
            toClient(message);
        }),
    );
    // Replays the handshake this process already answered, so the backend starts believing it began the conversation;
    // the client's own initialize params ride along.
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
                            ? `this call names no account, pass \`account\` (granted this turn: ${Object.keys(manifest.accounts).join(", ")})`
                            : `no account "${account}" this turn can act as, granted: ${Object.keys(manifest.accounts).join(", ")}. ` +
                              `An account opened this turn lives in its identity's browser: pass the identity's id.`,
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
            // Trimmed opportunistically: a route matters only while its call is in flight.
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

// The turn ending closes stdin: the browsers behind this process have nobody left to drive them.
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));
