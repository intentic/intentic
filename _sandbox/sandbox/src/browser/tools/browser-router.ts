import { type ChildProcess, spawn } from "node:child_process";
import { spawnAs } from "../../workload/workload-class.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import type { RpcMessage } from "../../agent/tools/turn-mounts.js";

// One MCP server standing in for every browser a turn may drive, hosted in this daemon and reached over HTTP, so a
// session costs no router process of its own. Each tool takes an `account`, resolved through the turn's manifest to an
// owner whose real @playwright/mcp backend spawns on the first call naming it; an unrecognised account is refused.
// A sole-owner manifest drops the `account` parameter and routes everything to that one owner: how the credential-free
// browser gets the same lazy spawn without its tool names growing an argument that has one legal value.
// The handshake and the tool list are answered from a schema cache, so a turn that never calls a browser tool never
// pays for one. Backends are this daemon's children and die when the turn that opened the router ends: the router is
// one of the turn's mounts (agent/tools/turn-mounts.ts), reached at the daemon's one MCP door and closed with the lease.
// Newline-delimited JSON-RPC 2.0 is the only framing the router speaks to a backend.

// One MCP tool as tools/list describes it; only the input schema is read here.
export interface McpToolSchema {
    readonly name: string;
    readonly inputSchema?: { readonly properties?: Record<string, unknown>; readonly required?: readonly string[] };
    readonly [key: string]: unknown;
}

// What a prepared owner takes to spawn: the full environment, not a delta, so a headless backend can be handed an
// environment with DISPLAY removed rather than one this process would merge its own back into.
export interface BrowserBackendSpec {
    readonly command: string;
    readonly args: readonly string[];
    readonly env: Record<string, string>;
}

export type Prepared = BrowserBackendSpec | { readonly refusal: string };

// What one turn may reach: every granted id resolved to its profile owner, and each owner's reserved CDP port.
export interface RouterManifest {
    readonly accounts: Readonly<Record<string, string>>;
    readonly owners: Readonly<Record<string, { readonly port: number }>>;
    readonly soleOwner?: string;
    // Laid over the prepared environment when a backend spawns: the turn's workload stamp, so the process scan
    // attributes the browser to its conversation.
    readonly backendEnv: Readonly<Record<string, string>>;
}

export interface RouterDeps {
    readonly toolSchemas: () => Promise<readonly McpToolSchema[]>;
    // Brings one owner up: display, exit, fingerprint and config are all daemon state (browser-tools.ts).
    readonly prepare: (owner: string, port: number) => Promise<Prepared>;
}

const PROTOCOL_VERSION = "2025-06-18";
const ROUTER_CLIENT = { name: "intentic-browser-router", version: "1.0.0" };

const lineReader = (onLine: (line: string) => void): ((chunk: Buffer) => void) => {
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

const parsed = (line: string): RpcMessage | undefined => {
    try {
        const message: unknown = JSON.parse(line);
        return typeof message === "object" && message !== null ? (message as RpcMessage) : undefined;
    } catch {
        // allow(silent-catch): a backend's stray non-JSON line (a warning printed to stdout) carries nothing to route.
        return undefined;
    }
};

// ---- the tool schemas, probed once per @playwright/mcp version and cached on disk for every later daemon ----------

// Asks a throwaway headless server for its tool list: initialize, tools/list, done. It never opens a page, so it
// launches no Chromium.
const probeTools = (probe: { readonly command: string; readonly args: readonly string[] }, timeoutMs: number): Promise<McpToolSchema[]> =>
    new Promise((resolve, reject) => {
        const child = spawn(probe.command, [...probe.args], { stdio: ["pipe", "pipe", "ignore"] });
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("schema probe timed out"));
        }, timeoutMs);
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        const send = (message: RpcMessage): void => {
            child.stdin.write(`${JSON.stringify(message)}\n`);
        };
        child.stdout.on(
            "data",
            lineReader((line) => {
                const message = parsed(line);
                if (message?.id === "probe-init") {
                    send({ jsonrpc: "2.0", method: "notifications/initialized" });
                    send({ jsonrpc: "2.0", id: "probe-tools", method: "tools/list", params: {} });
                } else if (message?.id === "probe-tools") {
                    clearTimeout(timer);
                    child.kill("SIGTERM");
                    resolve(((message.result as { tools?: McpToolSchema[] } | undefined)?.tools ?? []) as McpToolSchema[]);
                }
            }),
        );
        send({
            jsonrpc: "2.0",
            id: "probe-init",
            method: "initialize",
            params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: ROUTER_CLIENT },
        });
    });

// Memoized per cache path: every router in this daemon shares one read, or one probe on a version's first use. A
// failed probe is forgotten so the next turn tries again rather than inheriting "no browser tools" for the boot.
export const createSchemaCache = (timeoutMs = 30_000) => {
    const loaded = new Map<string, Promise<McpToolSchema[]>>();
    return (cachePath: string, probe: { readonly command: string; readonly args: readonly string[] }): Promise<McpToolSchema[]> => {
        const known = loaded.get(cachePath);
        if (known !== undefined) {
            return known;
        }
        const reading = (async () => {
            const cached = await readFile(cachePath, "utf8").then(
                (text) => JSON.parse(text) as McpToolSchema[],
                () => undefined,
            );
            if (cached !== undefined) {
                return cached;
            }
            const tools = await probeTools(probe, timeoutMs);
            // Written through a temp file: two daemons probing at once would otherwise interleave one file.
            const temp = `${cachePath}.${process.pid}.tmp`;
            await mkdir(dirname(cachePath), { recursive: true })
                .then(() => writeFile(temp, JSON.stringify(tools)))
                .then(() => rename(temp, cachePath))
                // allow(silent-catch): a cache that could not be written costs the next boot one more probe; this answer is in hand.
                .catch(() => undefined);
            return tools;
        })();
        loaded.set(cachePath, reading);
        reading.catch(() => loaded.delete(cachePath));
        return reading;
    };
};

// ---- one owner's lazily spawned real server --------------------------------------------------------------------

interface Backend {
    readonly child: ChildProcess;
    // Backend-side request id to the resolver of its answer.
    readonly pending: Map<number, (message: RpcMessage) => void>;
    nextId: number;
    // Settles once the replayed handshake is answered; calls wait on it rather than queueing lines by hand.
    readonly ready: Promise<void>;
}

const rpcError = (id: RpcMessage["id"], code: number, message: string): RpcMessage => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

// A refusal is a tool result, not a JSON-RPC error: the model reads the sentence and picks another account or waits.
const toolRefusal = (id: RpcMessage["id"], text: string): RpcMessage => ({
    jsonrpc: "2.0",
    id: id ?? null,
    result: { content: [{ type: "text", text }], isError: true },
});

const ACCOUNT_PROPERTY = {
    type: "string",
    description:
        "Which account to act as: a connected account's capability id, or an identity's id for its own browser. " +
        "The account skills and `mcp__accounts__roster` name the ones this sandbox holds.",
};

// Required, so a call can't leave the router guessing the profile. Granted ids are not enumerated per tool, to avoid
// re-multiplying the schemas the router exists to collapse.
const withAccountParameter = (tools: readonly McpToolSchema[]): McpToolSchema[] =>
    tools.map((tool) => {
        const schema: NonNullable<McpToolSchema["inputSchema"]> & { readonly type?: string } = tool.inputSchema ?? { type: "object", properties: {} };
        return {
            ...tool,
            inputSchema: {
                ...schema,
                properties: { ...schema.properties, account: ACCOUNT_PROPERTY },
                required: [...(schema.required ?? []), "account"],
            },
        };
    });

export interface BrowserRouter {
    // Answers one client message; undefined for a notification, which expects none. `signal` is the HTTP request's
    // own: a client that hung up takes its in-flight call with it.
    readonly handle: (message: RpcMessage, signal?: AbortSignal) => Promise<RpcMessage | undefined>;
    // Kills every backend; later calls are refused, not respawned.
    readonly close: () => void;
    // Owners whose backend is running now; for tests and the hub's accounting.
    readonly live: () => readonly string[];
}

export const createBrowserRouter = (manifest: RouterManifest, deps: RouterDeps): BrowserRouter => {
    const backends = new Map<string, Backend>();
    // Owner to the bring-up in flight, so two racing first calls prepare, and spawn, once.
    const preparing = new Map<string, Promise<{ readonly backend: Backend } | { readonly refusal: string }>>();
    // Client request id to the backend call it became, so a cancellation chases its call.
    const inflight = new Map<string | number, { readonly backend: Backend; readonly id: number }>();
    let clientInitialize: Record<string, unknown> | undefined;
    let closed = false;

    const send = (backend: Backend, message: RpcMessage): void => {
        try {
            backend.child.stdin?.write(`${JSON.stringify(message)}\n`);
        } catch {
            // allow(silent-catch): the backend went away mid-write; its exit handler answers everything it still owed.
        }
    };

    const request = (
        backend: Backend,
        method: string,
        params: Record<string, unknown> | undefined,
    ): { readonly id: number; readonly answer: Promise<RpcMessage> } => {
        const id = backend.nextId++;
        const answer = new Promise<RpcMessage>((resolve) => backend.pending.set(id, resolve));
        send(backend, { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
        return { id, answer };
    };

    // The environment arrives whole from the prepare step, not merged over the daemon's: a headless backend needs
    // DISPLAY absent, which a merge could not express.
    const spawnBackend = (owner: string, spec: BrowserBackendSpec): Backend => {
        // A service: the browser it drives is restarted on the next call, and Chromium raises its own renderers above it.
        const child = spawnAs({ class: "service" }, spec.command, [...spec.args], { env: { ...spec.env, ...manifest.backendEnv }, stdio: ["pipe", "pipe", "ignore"] });
        let markReady: () => void = () => undefined;
        const backend: Backend = { child, pending: new Map(), nextId: 1, ready: new Promise((resolve) => (markReady = resolve)) };
        backends.set(owner, backend);
        const gone = (): void => {
            if (backends.get(owner) === backend) {
                backends.delete(owner);
            }
            markReady();
            for (const [id, resolve] of backend.pending) {
                resolve(rpcError(id, -32603, `${owner}: the browser exited mid-call`));
            }
            backend.pending.clear();
        };
        child.on("error", gone);
        child.on("exit", gone);
        child.stdout?.on(
            "data",
            lineReader((line) => {
                const message = parsed(line);
                if (message === undefined) {
                    return;
                }
                // A backend-initiated request (elicitation, sampling) has no client to reach over a stateless HTTP
                // answer; refused, so the backend doesn't wait on it forever.
                if (message.method !== undefined) {
                    if (message.id !== undefined) {
                        send(backend, rpcError(message.id, -32601, `"${message.method}" is not relayed by the browser router`));
                    }
                    return;
                }
                const resolve = typeof message.id === "number" ? backend.pending.get(message.id) : undefined;
                if (resolve !== undefined) {
                    backend.pending.delete(message.id as number);
                    resolve(message);
                }
            }),
        );
        // Replays the handshake the router already answered, so the backend believes it began the conversation; the
        // client's own initialize params ride along.
        void request(
            backend,
            "initialize",
            clientInitialize ?? { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: ROUTER_CLIENT },
        ).answer.then(() => {
            send(backend, { jsonrpc: "2.0", method: "notifications/initialized" });
            markReady();
        });
        return backend;
    };

    // One prepare per owner even under concurrent calls; a refused owner is not remembered as refused, since the
    // reason (a login window open, an exit still dialling) can pass before the turn ends.
    const backendFor = (owner: string, port: number): Promise<{ readonly backend: Backend } | { readonly refusal: string }> => {
        const existing = backends.get(owner);
        if (existing !== undefined) {
            return Promise.resolve({ backend: existing });
        }
        const pending = preparing.get(owner);
        if (pending !== undefined) {
            return pending;
        }
        const started = deps
            .prepare(owner, port)
            .catch((error: unknown) => ({ refusal: `${owner}: that browser could not be started (${errorMessage(error)})` }))
            .then((prepared) => {
                if ("refusal" in prepared) {
                    return prepared;
                }
                if (closed) {
                    return { refusal: `${owner}: this turn's browsers are already closed` };
                }
                return { backend: spawnBackend(owner, prepared) };
            })
            .finally(() => preparing.delete(owner));
        preparing.set(owner, started);
        return started;
    };

    const granted = (): string => Object.keys(manifest.accounts).join(", ");

    const call = async (message: RpcMessage, signal: AbortSignal | undefined): Promise<RpcMessage> => {
        // `account` is stripped either way: a sole-owner router never declared it, so one passed anyway is noise the
        // real server would reject.
        const { account, ...rest } = (message.params?.["arguments"] ?? {}) as Record<string, unknown>;
        const owner = manifest.soleOwner ?? (typeof account === "string" ? manifest.accounts[account] : undefined);
        const reserved = owner === undefined ? undefined : manifest.owners[owner];
        if (owner === undefined || reserved === undefined) {
            return toolRefusal(
                message.id,
                typeof account !== "string"
                    ? `this call names no account, pass \`account\` (granted this turn: ${granted()})`
                    : `no account "${account}" this turn can act as, granted: ${granted()}. ` +
                          `An account opened this turn lives in its identity's browser: pass the identity's id.`,
            );
        }
        if (closed) {
            return toolRefusal(message.id, "this turn's browsers are already closed");
        }
        // The first call for an owner waits on its bring-up; other requests are separate HTTP calls, so a second
        // account's call is not stuck behind the first one's Chromium starting.
        const ready = await backendFor(owner, reserved.port);
        if ("refusal" in ready) {
            return toolRefusal(message.id, ready.refusal);
        }
        await ready.backend.ready;
        const sent = request(ready.backend, "tools/call", { ...message.params, arguments: rest });
        const clientId = message.id ?? undefined;
        if (clientId !== undefined && clientId !== null) {
            inflight.set(clientId, { backend: ready.backend, id: sent.id });
        }
        const hangUp = (): void =>
            send(ready.backend, { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: sent.id, reason: "client went away" } });
        signal?.addEventListener("abort", hangUp, { once: true });
        try {
            const answer = await sent.answer;
            return { ...answer, id: message.id ?? null };
        } finally {
            signal?.removeEventListener("abort", hangUp);
            if (clientId !== undefined && clientId !== null) {
                inflight.delete(clientId);
            }
        }
    };

    const handle = async (message: RpcMessage, signal?: AbortSignal): Promise<RpcMessage | undefined> => {
        switch (message.method) {
            case "initialize":
                clientInitialize = message.params;
                return {
                    jsonrpc: "2.0",
                    id: message.id ?? null,
                    result: {
                        protocolVersion: (message.params?.["protocolVersion"] as string | undefined) ?? PROTOCOL_VERSION,
                        capabilities: { tools: {} },
                        serverInfo: { name: "intentic-browser", version: "1.0.0" },
                    },
                };
            case "ping":
                return { jsonrpc: "2.0", id: message.id ?? null, result: {} };
            // Answered from the schema cache: the tool list is what a client needs before it can call anything, and
            // paying a browser to learn it is the cost the router exists to avoid.
            case "tools/list":
                try {
                    const tools = await deps.toolSchemas();
                    return {
                        jsonrpc: "2.0",
                        id: message.id ?? null,
                        result: { tools: manifest.soleOwner !== undefined ? tools : withAccountParameter(tools) },
                    };
                } catch (error) {
                    return rpcError(message.id, -32603, `browser tools unavailable: ${errorMessage(error)}`);
                }
            case "tools/call":
                return call(message, signal);
            // A call whose backend is still being prepared has sent nothing to cancel; it lands when the backend does.
            case "notifications/cancelled": {
                const route = inflight.get(message.params?.["requestId"] as string | number);
                if (route !== undefined) {
                    send(route.backend, { ...message, params: { ...message.params, requestId: route.id } });
                }
                return undefined;
            }
            default:
                // Other notifications (initialized, progress) need nothing from a router; any other request is a
                // question only a specific backend could answer, and nothing here says which one.
                return message.id === undefined ? undefined : rpcError(message.id, -32601, `unsupported method "${String(message.method)}"`);
        }
    };

    return {
        handle,
        close: () => {
            closed = true;
            for (const backend of backends.values()) {
                backend.child.kill("SIGTERM");
            }
            backends.clear();
        },
        live: () => [...backends.keys()],
    };
};

// Makes one turn's router: the turn's lease owns it from there, and closes it when the turn ends.
export type BrowserRouterFactory = (manifest: RouterManifest) => BrowserRouter;
