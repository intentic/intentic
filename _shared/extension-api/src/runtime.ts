import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { createBackoff, sleep } from "@intentic/base/async";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { queueOnFile, writeFileAtomic } from "@intentic/base/fs";
import { sandboxRouteAllowed } from "@intentic/extension-manifest/permissions";
import type * as SandboxContract from "@intentic/sandbox-contract";
import { readDocument } from "@intentic/sandbox-contract/documents";
import {
    EXTENSION_EVENT_KINDS,
    EXTENSION_EVENTS_HEARTBEAT_MS,
    EXTENSION_PROCESS_ENV,
    type ExtensionEventKind,
    ExtensionEventSchema,
    extensionEventsUrl,
    ExtensionHealthSchema,
    ExtensionOwnSettingsSchema,
    ExtensionPermissionsSchema,
    extensionSettingsUrl,
} from "@intentic/sandbox-contract/extension-protocol";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/headers";
import type * as OrpcClient from "@orpc/client";
import type * as OpenApiFetch from "@orpc/openapi-client/fetch";
import type { Disposable } from "./disposable.js";
import type {
    BackendRouteHandler,
    ExtensionHealth,
    ExtensionProcessApi,
    ExtensionServerApi,
    ExtensionServerContext,
    ExtensionServerModule,
    ServerActivation,
    ServerDocument,
    ServerDocumentOptions,
    StoredJson,
    ToolCard,
    ToolDefinition,
} from "./server.js";
import { extensionApiVersion } from "./version.js";

// The backend half's types, from here as well as from the package root: the root also carries the browser half, whose
// types name Vue's, which a gateway's program has no business loading.
export type {
    BackendRouteHandler,
    ExtensionHealth,
    ExtensionHealthState,
    ExtensionProcessApi,
    ExtensionServerApi,
    ExtensionServerContext,
    ExtensionServerModule,
    ExtensionSettingValues,
    ServerActivation,
    ServerDocument,
    ServerDocumentOptions,
    StoredJson,
    ToolCallContext,
    ToolCard,
    ToolContent,
    ToolDefinition,
    ToolEffect,
    ToolResult,
} from "./server.js";

// The backend api, built once for every place an extension's Node code runs: the daemon's backend host, which runs every
// `server` bundle in one process, and each declared process (`contributes.processes`), which connects itself from the
// environment the daemon started it with. One implementation, so a gateway and a server bundle reach the daemon, read
// their settings, hear about the workspace and keep their files the same way. Node only, and free of Vue, unlike the
// package's root: a gateway that imports this loads none of the browser half.

type DaemonApi = ExtensionServerApi["daemon"];
type Rpc = DaemonApi["rpc"];
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

// What one `api.tools.serve` registration answers with, per card.
export type ToolSource = (card: ToolCard | undefined) => readonly ToolDefinition[] | Promise<readonly ToolDefinition[]>;

export interface DaemonApiOptions {
    // The daemon's loopback origin.
    readonly url: string;
    // The extension's minted token, which the daemon judges every request by.
    readonly token: string;
    // The extension's routing id, for the sentence a refusal says.
    readonly id: string;
    // The manifest's `permissions.daemon`: a typed call outside it is refused before anything is sent.
    readonly permissions: readonly string[];
    // Where requests go; the global `fetch` when absent, read at call time so a test can stand in for it.
    readonly fetch?: Fetch | undefined;
}

// Loads a module synchronously, which Node 22+ and Bun both do for ESM; used only for what a process should not pay for
// until it is asked for.
const load = createRequire(import.meta.url);

// The typed client over the daemon's contract, gated by the extension's declared reach and parsing every answer by the
// procedure's own schema.
const typedClient = (options: DaemonApiOptions, send: Fetch): Rpc => {
    // SAFETY: each name is the package the type beside it is taken from, loaded by its own export map.
    const contract = load("@intentic/sandbox-contract") as typeof SandboxContract;
    // SAFETY: as above.
    const { createORPCClient } = load("@orpc/client") as typeof OrpcClient;
    // SAFETY: as above.
    const { OpenAPILink } = load("@orpc/openapi-client/fetch") as typeof OpenApiFetch;
    return createORPCClient<Rpc>(
        new OpenAPILink(contract.sandboxContract, {
            url: options.url,
            headers: { [EXTENSION_TOKEN_HEADER]: options.token },
            fetch: (request, init) => send(request, init),
            interceptors: [
                // A procedure this build's contract does not declare is refused too: reaching one means a hand-built path.
                ({ path, input, next }) => {
                    const request = contract.sandboxRequestFor(path, input);
                    if (request === undefined) {
                        throw new Error(`extension "${options.id}" called daemon procedure ${path.join(".")}, which this build's contract does not declare`);
                    }
                    if (!sandboxRouteAllowed(options.permissions, request.method, request.path)) {
                        throw new Error(
                            `extension "${options.id}" called undeclared daemon route ${request.method} ${request.path}: declare it in permissions.daemon in the manifest`,
                        );
                    }
                    return next();
                },
                async ({ path, next }) => {
                    const answer = await next();
                    const schema = contract.sandboxAnswerSchema(path);
                    return schema === undefined ? answer : schema.parse(answer);
                },
            ],
        }),
    );
};

// One extension's `api.daemon`, every door presenting its minted token, which the daemon judges each request by. The
// typed client is also judged here, before anything is sent: on the method and path a call resolves to, against the same
// `permissions.daemon` list, so a refusal names the missing declaration instead of arriving as the daemon's 403. It is
// built on first use: the contract it is built from holds every schema the daemon has, tens of megabytes a gateway that
// never makes a typed call should not pay for at start.
export const createDaemonApi = (options: DaemonApiOptions): DaemonApi => {
    const send: Fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, init);
    const granted = (init?: RequestInit): Headers => {
        const headers = new Headers(init?.headers);
        headers.set(EXTENSION_TOKEN_HEADER, options.token);
        return headers;
    };
    let client: Rpc | undefined;
    return {
        get rpc(): Rpc {
            client ??= typedClient(options, send);
            return client;
        },
        request: (path, init) => send(`${options.url}${path}`, { ...init, headers: granted(init) }),
        json: async <T>(path: string, init?: RequestInit): Promise<T> => {
            const headers = granted(init);
            if (init?.body !== undefined && !headers.has("content-type")) {
                headers.set("content-type", "application/json");
            }
            const response = await send(`${options.url}${path}`, { ...init, headers });
            if (!response.ok) {
                throw new Error(`daemon answered ${response.status} for ${init?.method ?? "GET"} ${path}: ${await response.text()}`);
            }
            // SAFETY: the caller names the shape the route answers; `api.daemon.rpc` is the door that checks it.
            return (await response.json()) as T;
        },
    };
};

type Listener = (values: readonly string[]) => void;

// How long a connection may go without a frame before it is taken for dead: three missed heartbeats.
const SILENCE_MS = EXTENSION_EVENTS_HEARTBEAT_MS * 3;

// Every complete line in `buffer`, and what is left after the last one.
const splitLines = (buffer: string) => {
    const parts = buffer.split("\n");
    const rest = parts.pop() ?? "";
    return { lines: parts.map((line) => line.trim()).filter((line) => line !== ""), rest };
};

// The values a frame carries for its listeners, or undefined for a line this version cannot read (not JSON, or a kind a
// newer daemon sends), which is skipped rather than fatal.
const frameOf = (line: string): { readonly kind: ExtensionEventKind; readonly values: readonly string[] } | undefined => {
    let raw: unknown;
    try {
        raw = JSON.parse(line);
    } catch {
        // allow(silent-catch): a line that is not JSON is a frame this version cannot read, skipped like an unknown kind
        return undefined;
    }
    const parsed = ExtensionEventSchema.safeParse(raw);
    if (!parsed.success) {
        return undefined;
    }
    const event = parsed.data;
    switch (event.kind) {
        case "heartbeat":
            return undefined;
        case "files":
            return { kind: event.kind, values: event.paths };
        case "settings":
            return { kind: event.kind, values: event.keys };
        default:
            return { kind: event.kind, values: event.repos };
    }
};

// The extension's event stream: opened by the first listener, closed with the last, reconnected with backoff while
// anything listens. A drop means frames were missed, so a reconnect tells every listener "anything may have changed" with
// an empty list, which is what a reader of an empty batch already does.
const createEventHub = (open: (signal: AbortSignal) => Promise<Response>, log: (message: string) => void) => {
    const listeners = new Map<ExtensionEventKind, Set<Listener>>(EXTENSION_EVENT_KINDS.map((kind) => [kind, new Set<Listener>()]));
    let running: AbortController | undefined;
    const count = (): number => [...listeners.values()].reduce((sum, set) => sum + set.size, 0);

    const deliver = (kind: ExtensionEventKind, values: readonly string[]): void => {
        for (const listener of listeners.get(kind) ?? []) {
            try {
                listener(values);
            } catch (error) {
                // A throwing listener is its own bug; the stream and every other listener carry on.
                log(`a ${kind} listener threw: ${errorMessage(error)}`);
            }
        }
    };

    // One connection, read to its end; resolves when the daemon ends it or it falls silent.
    const connect = async (outer: AbortSignal): Promise<void> => {
        const connection = new AbortController();
        const abort = (): void => connection.abort();
        outer.addEventListener("abort", abort, { once: true });
        let silence = setTimeout(abort, SILENCE_MS);
        try {
            const response = await open(connection.signal);
            if (!response.ok || response.body === null) {
                throw new Error(`the daemon answered ${response.status}`);
            }
            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = "";
            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
                clearTimeout(silence);
                silence = setTimeout(abort, SILENCE_MS);
                const split = splitLines(buffer + decoder.decode(chunk.value, { stream: true }));
                buffer = split.rest;
                for (const line of split.lines) {
                    const frame = frameOf(line);
                    if (frame !== undefined) {
                        deliver(frame.kind, frame.values);
                    }
                }
            }
        } finally {
            clearTimeout(silence);
            outer.removeEventListener("abort", abort);
        }
    };

    // Every connection after the first follows a gap, which a listener hears about as an empty batch.
    const run = async (signal: AbortSignal): Promise<void> => {
        let connections = 0;
        const backoff = createBackoff({ floorMs: 1_000, capMs: 30_000, stableMs: SILENCE_MS });
        while (!signal.aborted) {
            if (connections > 0) {
                for (const kind of EXTENSION_EVENT_KINDS) {
                    deliver(kind, []);
                }
            }
            connections += 1;
            const opened = Date.now();
            try {
                await connect(signal);
            } catch (error) {
                if (!signal.aborted) {
                    log(`the event stream dropped (${errorMessage(error)}); reconnecting`);
                }
            }
            if (signal.aborted) {
                return;
            }
            await sleep(backoff.next(Date.now() - opened), { signal, unref: true });
        }
    };

    const subscribe = (kind: ExtensionEventKind, listener: Listener): Disposable => {
        listeners.get(kind)?.add(listener);
        if (running === undefined) {
            running = new AbortController();
            void run(running.signal);
        }
        return {
            dispose: () => {
                listeners.get(kind)?.delete(listener);
                if (count() === 0) {
                    running?.abort();
                    running = undefined;
                }
            },
        };
    };

    return {
        subscribe,
        close: (): void => {
            for (const set of listeners.values()) {
                set.clear();
            }
            running?.abort();
            running = undefined;
        },
    };
};

// A JSON file under the extension's own state directory, read through the contract's one document reading.
const openDocument = <T>(stateDir: string, path: string, options: ServerDocumentOptions<T>): ServerDocument<T> => {
    const file = resolve(stateDir, path);
    const inside = relative(stateDir, file);
    if (inside === "" || inside.startsWith("..") || isAbsolute(inside)) {
        throw new Error(`document "${path}" must name a file inside the extension's state directory`);
    }
    const evolution = { history: options.history ?? [], granularity: options.granularity ?? "object" } as const;
    const readAs = async () => {
        const text = await readFile(file, "utf8").catch(undefinedIfMissing);
        // SAFETY: readDocument hands its parse what JSON.parse produced and the conversions rewrote, which is JSON.
        return text === undefined ? undefined : readDocument<T>(text, evolution, { kind: "whole", parse: (raw) => options.parse(raw as StoredJson) });
    };
    return {
        read: async () => (await readAs())?.value ?? options.fallback(),
        update: (change) =>
            queueOnFile(file, async () => {
                const stored = await readAs();
                if (stored !== undefined && stored.value === undefined) {
                    throw new Error(`${path} holds what this version of the extension cannot read; it is left as it is`, { cause: stored.problems[0] });
                }
                const before = stored?.value ?? options.fallback();
                const after = change(before);
                if (after === before) {
                    return before;
                }
                const written = stored === undefined ? after : stored.carry(after);
                await writeFileAtomic(file, `${JSON.stringify(written, undefined, 2)}\n`);
                return after;
            }),
    };
};

export interface ExtensionRuntimeOptions {
    // The extension's routing id: its /x/<id> namespace, the install id.
    readonly id: string;
    readonly daemonUrl: string;
    readonly token: string;
    // The manifest's `permissions.daemon`.
    readonly permissions: readonly string[];
    readonly workspaceRoot: string;
    readonly extensionDir: string;
    readonly stateDir: string;
    readonly cacheDir: string;
    // Where a log line goes; stdout with the id as a prefix when absent, which is what reaches the daemon's log.
    readonly log?: ((message: string) => void) | undefined;
    readonly fetch?: Fetch | undefined;
}

export interface ExtensionRuntime {
    readonly api: ExtensionProcessApi;
    // Ends what the runtime holds open on the extension's behalf (the event stream). The host calls it as it lets go of
    // an activation; a process may leave it to its own exit.
    close(): void;
}

export const createExtensionRuntime = (options: ExtensionRuntimeOptions): ExtensionRuntime => {
    const log = options.log ?? ((message: string) => void process.stdout.write(`[${options.id}] ${message}\n`));
    const daemon = createDaemonApi({ url: options.daemonUrl, token: options.token, id: options.id, permissions: options.permissions, fetch: options.fetch });
    const events = createEventHub((signal) => daemon.request(extensionEventsUrl(), { signal }), log);
    return {
        api: {
            apiVersion: extensionApiVersion,
            workspaceRoot: options.workspaceRoot,
            extensionDir: options.extensionDir,
            stateDir: options.stateDir,
            cacheDir: options.cacheDir,
            log,
            daemon,
            document: (path, documentOptions) => openDocument(options.stateDir, path, documentOptions),
            settings: {
                get: async () => ExtensionOwnSettingsSchema.parse(await (await daemon.request(extensionSettingsUrl())).json()).settings,
                onDidChange: (listener) => events.subscribe("settings", listener),
            },
            workspace: {
                onDidChangeFiles: (listener) => events.subscribe("files", listener),
                onDidChangeRefs: (listener) => events.subscribe("refs", listener),
                onDidChangeRepos: (listener) => events.subscribe("repos", listener),
            },
        },
        close: events.close,
    };
};

// The backend api a `server` bundle is handed: the runtime plus the two slots only the host serves, its route namespace
// and its tools. A second `mount` or `serve` replaces the first, per the api's contract.
export interface ServerApiSlots {
    readonly api: ExtensionServerApi;
    readonly handler: () => BackendRouteHandler | undefined;
    readonly tools: () => ToolSource | undefined;
    close(): void;
}

export const createServerApi = (options: ExtensionRuntimeOptions): ServerApiSlots => {
    const runtime = createExtensionRuntime(options);
    let mounted: BackendRouteHandler | undefined;
    let tools: ToolSource | undefined;
    return {
        api: {
            ...runtime.api,
            routes: {
                mount: (handler) => {
                    mounted = handler;
                },
            },
            tools: {
                serve: (source) => {
                    tools = source;
                },
            },
        },
        handler: () => mounted,
        tools: () => tools,
        close: runtime.close,
    };
};

// A server bundle's exports: `activateServer` as a default export's member or a named export, matching the web loader's
// tolerance for UI bundles.
export type ServerBundleExports = Partial<ExtensionServerModule> & { readonly default?: ExtensionServerModule };

// Resolves activateServer and activates it. What it hands back is kept whole; nothing handed back reads as an activation
// with neither half.
export const activateServerModule = async (imported: ServerBundleExports, api: ExtensionServerApi, context: ExtensionServerContext): Promise<ServerActivation> => {
    const resolved = imported.default ?? imported;
    if (resolved.activateServer === undefined) {
        throw new Error("the server bundle exports no activateServer(api, context)");
    }
    return (await resolved.activateServer(api, context)) ?? {};
};

// How long one extension's `deactivate` and `health` may take before the host goes on without them.
export const DEACTIVATE_DEADLINE_MS = 2_500;
export const HEALTH_DEADLINE_MS = 2_000;

// `work`'s answer, or `late` once `ms` passes, whichever comes first; the timer never holds the process open.
const within = async <T, L>(work: () => T | Promise<T>, ms: number, late: L): Promise<T | L> => {
    let timer: NodeJS.Timeout | undefined;
    const lateness = new Promise<L>((settle) => {
        timer = setTimeout(() => settle(late), ms);
        timer.unref();
    });
    try {
        return await Promise.race([Promise.resolve().then(work), lateness]);
    } finally {
        clearTimeout(timer);
    }
};

// Runs an activation's `deactivate` under the deadline. A throw or a timeout is said, never raised: the code is being
// replaced either way, and the caller's next step must not wait on it.
export const deactivateWithin = async (activation: ServerActivation, log: (message: string) => void): Promise<void> => {
    const deactivate = activation.deactivate;
    if (deactivate === undefined) {
        return;
    }
    try {
        const outcome = await within(async () => {
            await deactivate();
            return "done" as const;
        }, DEACTIVATE_DEADLINE_MS, "late" as const);
        if (outcome === "late") {
            log(`deactivate did not finish within ${DEACTIVATE_DEADLINE_MS} ms; its code is replaced anyway`);
        }
    } catch (error) {
        log(`deactivate threw: ${errorMessage(error)}`);
    }
};

// An activation's own account of itself, read under the deadline and held to the closed vocabulary: no `health` reads as
// `ok`, and one that throws, does not answer in time or answers outside the vocabulary reads as `degraded`, saying so.
export const healthWithin = async (activation: ServerActivation): Promise<ExtensionHealth> => {
    const health = activation.health;
    if (health === undefined) {
        return { state: "ok" };
    }
    const late: ExtensionHealth = { state: "degraded", detail: `its health check did not answer within ${HEALTH_DEADLINE_MS} ms` };
    try {
        const answer = await within(health, HEALTH_DEADLINE_MS, late);
        const parsed = ExtensionHealthSchema.safeParse(answer);
        if (!parsed.success) {
            return { state: "degraded", detail: "its health check answered something other than ok, starting, degraded or failed" };
        }
        return parsed.data.detail === undefined ? { state: parsed.data.state } : { state: parsed.data.state, detail: parsed.data.detail };
    } catch (error) {
        return { state: "degraded", detail: `its health check threw: ${errorMessage(error)}` };
    }
};

// Reads the variable or says which one is missing: only the daemon starts an extension's process, and a process started
// any other way has no token to reach it with.
const required = (env: NodeJS.ProcessEnv, name: string): string => {
    const value = env[name];
    if (value === undefined || value === "") {
        throw new Error(`missing ${name}: an extension's process is started by the sandbox daemon, which sets it`);
    }
    return value;
};

const permissionsOf = (raw: string | undefined): readonly string[] => {
    if (raw === undefined || raw === "") {
        return [];
    }
    const parsed = ExtensionPermissionsSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
        throw new Error(`${EXTENSION_PROCESS_ENV.permissions} is not a JSON array of permissions`);
    }
    return parsed.data;
};

// A declared process's api, from the environment the daemon started it with (EXTENSION_PROCESS_ENV). Throws, naming the
// variable, when one it needs is missing.
export const connectExtensionProcess = (env: NodeJS.ProcessEnv = process.env, options: { readonly log?: (message: string) => void } = {}): ExtensionRuntime =>
    createExtensionRuntime({
        id: required(env, EXTENSION_PROCESS_ENV.id),
        daemonUrl: required(env, EXTENSION_PROCESS_ENV.daemon),
        token: required(env, EXTENSION_PROCESS_ENV.token),
        permissions: permissionsOf(env[EXTENSION_PROCESS_ENV.permissions]),
        workspaceRoot: required(env, EXTENSION_PROCESS_ENV.workspace),
        extensionDir: env[EXTENSION_PROCESS_ENV.dir] ?? process.cwd(),
        stateDir: required(env, EXTENSION_PROCESS_ENV.state),
        cacheDir: required(env, EXTENSION_PROCESS_ENV.cache),
        log: options.log,
    });
