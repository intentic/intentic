#!/usr/bin/env node
// browser-router <manifest.json>: one stdio MCP server standing in for every signed-in browser. Each tool takes an
// `account`, resolved through the manifest to an owner whose real backend spawns lazily on first use; an unrecognised
// account is refused. Backends are children of this process: stdin closing ends the turn and kills them.
// A sole-owner manifest drops the `account` parameter and routes everything to that one owner: how the credential-free
// browser gets the same lazy spawn without its tool names growing an argument that has one legal value.
// Nothing here knows how to build a browser. The first call naming an owner asks the daemon for its spawn spec, since
// display allocation, profile locks, fingerprints and exits are all daemon state.

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
//   owners: { <owner>: { port } }, prepare: { url, token }, backendEnv: { ... }, soleOwner?: <owner> }

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
// owner → Promise<{ backend } | { refusal }> while its spec is being fetched, so two racing calls prepare once.
const preparing = new Map();

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
// A sole-owner router has one legal answer, so the parameter would be noise on every schema it serves.
const withAccountParameter = (tools) =>
    manifest.soleOwner !== undefined
        ? tools
        : tools.map((tool) => {
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

// The daemon's answer is the whole spawn: the display it started, the exit it dialled, the config it wrote. A refusal
// comes back as prose for the model, not an error, since "that account's exit is down" is a fact it can act on.
const askDaemon = async (owner) => {
    const response = await fetch(manifest.prepare.url, {
        method: "POST",
        headers: { authorization: `Bearer ${manifest.prepare.token}`, "content-type": "application/json" },
        body: JSON.stringify({ owner, port: manifest.owners[owner].port }),
    });
    if (!response.ok) {
        return { refusal: `${owner}: this sandbox refused to start that browser (HTTP ${response.status})` };
    }
    const prepared = await response.json();
    return typeof prepared?.command === "string"
        ? prepared
        : { refusal: typeof prepared?.refusal === "string" ? prepared.refusal : `${owner}: this sandbox started no browser for it` };
};

// The environment arrives whole from the daemon, not merged over this process's: a headless backend needs DISPLAY
// absent, which a merge could not express. backendEnv is the turn's workload stamp, which the daemon doesn't carry.
const spawnBackend = (owner, spec) => {
    const child = spawn(spec.command, spec.args, {
        env: { ...spec.env, ...manifest.backendEnv },
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

// One prepare per owner even under concurrent calls; a refused owner is not remembered as refused, since the reason
// (a login window open, an exit still dialling) can pass before the turn ends.
const backendFor = (owner) => {
    const existing = backends.get(owner);
    if (existing !== undefined) {
        return Promise.resolve({ backend: existing });
    }
    const pending = preparing.get(owner);
    if (pending !== undefined) {
        return pending;
    }
    const started = askDaemon(owner)
        .catch((error) => ({ refusal: `${owner}: this sandbox could not be reached to start that browser (${error?.message ?? error})` }))
        .then((prepared) => ("refusal" in prepared ? prepared : { backend: spawnBackend(owner, prepared) }))
        .finally(() => preparing.delete(owner));
    preparing.set(owner, started);
    return started;
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

// A refusal is a tool result, not a JSON-RPC error: the model reads the sentence and picks another account or waits.
const toolRefusal = (id, text) => toClient({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: true } });

const refusal = (id, account) =>
    toolRefusal(
        id,
        account === undefined
            ? `this call names no account, pass \`account\` (granted this turn: ${Object.keys(manifest.accounts).join(", ")})`
            : `no account "${account}" this turn can act as, granted: ${Object.keys(manifest.accounts).join(", ")}. ` +
                  `An account opened this turn lives in its identity's browser: pass the identity's id.`,
    );

// One function per JSON-RPC method this process answers itself; anything absent belongs to a backend nothing here
// can name.
const clientMethods = {
    initialize: (message) => {
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
    },
    "notifications/initialized": () => {},
    // A call whose backend is still being prepared has launched nothing to cancel; it lands when the backend does.
    "notifications/cancelled": (message) => {
        const owner = callRoutes.get(message.params?.requestId);
        const backend = owner === undefined ? undefined : backends.get(owner);
        if (backend !== undefined) {
            forward(backend, message);
        }
    },
    ping: (message) => toClient({ jsonrpc: "2.0", id: message.id, result: {} }),
    // Answered from the schema cache: the tool list is what a client needs before it can call anything, and paying a
    // browser to learn it is the cost this router exists to avoid.
    "tools/list": (message) => {
        void toolSchemas().then(
            (tools) => toClient({ jsonrpc: "2.0", id: message.id, result: { tools: withAccountParameter(tools) } }),
            (error) =>
                toClient({
                    jsonrpc: "2.0",
                    id: message.id,
                    error: { code: -32603, message: `browser tools unavailable: ${error?.message ?? error}` },
                }),
        );
    },
    "tools/call": (message) => {
        // `account` is stripped either way: a sole-owner router never declared it, so one passed anyway is noise the
        // real server would reject.
        const { account, ...rest } = message.params?.arguments ?? {};
        const owner = manifest.soleOwner ?? (typeof account === "string" ? manifest.accounts[account] : undefined);
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
        // The first call for an owner waits on its bring-up; this pipe stays readable meanwhile, so a second account's
        // call is not stuck behind the first one's Chromium starting.
        void backendFor(owner).then((ready) => {
            if (ready.refusal !== undefined) {
                callRoutes.delete(message.id);
                toolRefusal(message.id, ready.refusal);
                return;
            }
            forward(ready.backend, { ...message, params: { ...message.params, arguments: rest } });
        });
    },
};

// The client answering a backend-initiated request: strip the prefix and route it home.
const answersBackend = (message) => message.method === undefined && typeof message.id === "string" && message.id.startsWith(BACKEND_ID_PREFIX);

const fromClient = (message) => {
    if (answersBackend(message)) {
        const route = backendRequests.get(message.id);
        backendRequests.delete(message.id);
        const backend = route === undefined ? undefined : backends.get(route.owner);
        if (backend !== undefined) {
            forward(backend, { ...message, id: route.id });
        }
        return;
    }
    const handler = clientMethods[message.method];
    if (handler !== undefined) {
        handler(message);
        return;
    }
    // Anything else is a question only a specific backend could answer, and nothing here says which one.
    if (message.id !== undefined) {
        toClient({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `unsupported method "${message.method}"` } });
    }
};

process.stdin.on(
    "data",
    lineReader((line) => {
        try {
            fromClient(JSON.parse(line));
        } catch {
            // A line that is not JSON, or a handler that threw: neither is worth ending the turn's browsing over.
        }
    }),
);

// The turn ending closes stdin: the browsers behind this process have nobody left to drive them.
process.stdin.on("end", () => shutdown(0));
process.stdin.on("close", () => shutdown(0));
