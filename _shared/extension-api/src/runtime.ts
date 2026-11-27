import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve } from "node:path";
import { within } from "@intentic/base/async";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import { FetchJsonError, fetchJson } from "@intentic/base/fetch-json";
import { queueOnFile, writeFileAtomic } from "@intentic/base/fs";
import {
    EXTENSION_FIRE_HANDLER,
    type ExtensionDeclaredReach,
    NO_DECLARED_REACH,
    sandboxRouteAllowed,
} from "@intentic/extension-manifest/permissions";
import type * as SandboxContract from "@intentic/sandbox-contract";
import { readDocument } from "@intentic/sandbox-contract/documents";
import {
    EXTENSION_CALLER_HEADER,
    EXTENSION_PROCESS_ENV,
    ExtensionDeclaredReachSchema,
    ExtensionHealthSchema,
    ExtensionOwnSettingsSchema,
    ExtensionPermissionsSchema,
    extensionSettingsUrl,
    readCallerClaim,
} from "@intentic/sandbox-contract/extension-protocol";
import { fenceAllows, foldPath } from "@intentic/sandbox-contract/policy/fence-paths";
import { EXTENSION_TOKEN_HEADER } from "@intentic/sandbox-contract/headers";
import type * as OrpcClient from "@orpc/client";
import type * as OpenApiFetch from "@orpc/openapi-client/fetch";
import { createBackendReach } from "./backend-reach.js";
import { createSleepReach } from "./sleep-reach.js";
import { createTurnReach } from "./turn-reach.js";
import type { Disposable } from "./disposable.js";
import type {
    ApprovedActionHandler,
    ApprovedPostHandler,
    AutomationFireHandler,
    BackendRouteHandler,
    DaemonDoors,
    ExtensionCaller,
    ExtensionHealth,
    ExtensionProcessApi,
    ExtensionServerApi,
    ExtensionServerContext,
    ExtensionServerModule,
    PublicRouteHandler,
    ServerActivation,
    ServerDocument,
    ServerDocumentOptions,
    StoredJson,
    ToolCard,
    ToolDefinition,
    WatchCheckHandler,
} from "./server.js";
import { extensionApiVersion } from "./version.js";

// The backend half's types, from here as well as from the package root: the root also carries the browser half, whose
// types name Vue's, which a gateway's program has no business loading.
export type {
    ApprovedAction,
    ApprovedActionHandler,
    ApprovedActionOutcome,
    ApprovedPost,
    ApprovedPostHandler,
    AutomationFire,
    AutomationFireHandler,
    BackendRouteHandler,
    BrowserCall,
    DaemonDoors,
    ExtensionCaller,
    ExtensionCallerWho,
    ExtensionHealth,
    ExtensionHealthState,
    ExtensionProcessApi,
    ExtensionServerApi,
    ExtensionServerContext,
    ExtensionServerModule,
    ExtensionSettingValues,
    JobEnd,
    JobSpec,
    OwnerBrowserCall,
    PublicRouteHandler,
    PublicRouteVerification,
    RunningJob,
    ServerActivation,
    ServerDocument,
    ServerDocumentOptions,
    SleepBoot,
    SleepHandler,
    SleepHeardMessage,
    SleepNotice,
    StartedJob,
    StoredJson,
    ToolArguments,
    ToolCallContext,
    ToolCallGrants,
    ToolCard,
    ToolContent,
    ToolDefinition,
    ToolEffect,
    ToolGrantAccount,
    TurnStanding,
    WatchCheck,
    WatchCheckAnswer,
    WatchCheckHandler,
    ToolResult,
} from "./server.js";
export type { ActivityRow, CiFeedEvent, ExecClass, ExecOptions, ExecResult, RunSettled, SandboxActivity } from "./server-reach.js";

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
    // Set on every request beside the token: a caller's assertion, for `asCaller`.
    readonly headers?: Readonly<Record<string, string>> | undefined;
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
            headers: { ...options.headers, [EXTENSION_TOKEN_HEADER]: options.token },
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
        for (const [name, value] of Object.entries(options.headers ?? {})) {
            headers.set(name, value);
        }
        headers.set(EXTENSION_TOKEN_HEADER, options.token);
        return headers;
    };
    let client: Rpc | undefined;
    return {
        get rpc(): Rpc {
            client ??= typedClient(options, send);
            return client;
        },
        // The same doors with the caller's assertion on every request; the daemon judges it, so a stale or foreign one is
        // its refusal to say, not this side's.
        asCaller: (caller: ExtensionCaller): DaemonDoors => {
            const { asCaller: _nested, ...doors } = createDaemonApi({ ...options, headers: { ...options.headers, [EXTENSION_CALLER_HEADER]: caller.assertion } });
            return doors;
        },
        request: (path, init) => send(`${options.url}${path}`, { ...init, headers: granted(init) }),
        // Over base's transport, through the same `send`: a 30 s deadline (with the caller's signal), and a refusal's
        // body cut to one line in the message instead of quoted whole.
        json: async <T>(path: string, init?: RequestInit): Promise<T> => {
            const method = init?.method ?? "GET";
            const headers = granted(init);
            // The caller serialized the body itself; it is JSON unless it said otherwise.
            const body = init?.body ?? undefined;
            if (body !== undefined && !headers.has("content-type")) {
                headers.set("content-type", "application/json");
            }
            const request = {
                method,
                headers,
                signal: init?.signal ?? undefined,
                label: `daemon ${method} ${path}`,
                // SAFETY: `send` is a fetch in all but bun-types' `preconnect`, which the transport never calls.
                fetch: send as typeof fetch,
            };
            try {
                const answer = await fetchJson(`${options.url}${path}`, body === undefined ? request : { ...request, body });
                // SAFETY: the caller names the shape the route answers; `api.daemon.rpc` is the door that checks it.
                return answer as T;
            } catch (error) {
                // A refusal keeps the sentence extensions already match on: the status, the call, the daemon's words.
                if (error instanceof FetchJsonError && error.kind === "status") {
                    throw new Error(`daemon answered ${error.status} for ${method} ${path}: ${error.body ?? ""}`, { cause: error });
                }
                throw error;
            }
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
    // The rest of the manifest's `permissions` (events, work, exec, fires): what the runtime asks for on the event
    // stream, and refuses before asking when undeclared. Nothing declared when absent.
    readonly declared?: ExtensionDeclaredReach | undefined;
    // The ids of the watch kinds its manifest declares (`contributes.watchKinds`): the checks its backend may serve.
    readonly watchKinds?: readonly string[] | undefined;
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
    const reach = createBackendReach(options.id, daemon.request, options.declared ?? NO_DECLARED_REACH, log);
    const { close: closeSleep, ...sleep } = createSleepReach(daemon.request, log);
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
                onDidChange: reach.onSettings,
            },
            workspace: reach.workspace,
            events: reach.events,
            work: reach.work,
            exec: reach.exec,
            activity: reach.activity,
            sleep,
        },
        close: () => {
            reach.close();
            closeSleep();
        },
    };
};

/**
 * Who a request into `/x/<id>` comes from, read off the assertion the daemon attached for extension `id`: undefined when
 * there is none, it does not read, it names another extension, or its window has passed. Its signature is the daemon's
 * to check (the host holds no key): what arrives here came through the daemon's proxy, which drops any the caller sent.
 */
export const callerOf = (request: Request, id: string, now = Date.now()): ExtensionCaller | undefined => {
    const assertion = request.headers.get(EXTENSION_CALLER_HEADER) ?? "";
    const claim = assertion === "" ? undefined : readCallerClaim(assertion);
    if (claim === undefined || claim.extension !== id || now >= claim.expiresAt) {
        return undefined;
    }
    // Only a person with areas is fenced; every other caller reads the workspace whole, as the daemon's routes answer it.
    const { folders, ...who } = claim.caller.kind === "person" ? claim.caller : { ...claim.caller, folders: undefined };
    // A path that climbs out of the workspace is inside nothing, whoever asks.
    const reaches = (path: string): boolean => foldPath(path) !== undefined && fenceAllows(folders, path);
    return { ...who, folders, reaches, expiresAt: claim.expiresAt, assertion };
};

// The backend api a `server` bundle is handed: the runtime plus the slots only the host serves, its route namespace, its
// tools, the approved actions it carries out and the handlers automations fire. A second `mount`, `serve`, `perform` or
// `onFire` for one name replaces the first, per the api's contract.
export interface ServerApiSlots {
    readonly api: ExtensionServerApi;
    readonly handler: () => BackendRouteHandler | undefined;
    // (2026-11-26) What answers the extension's public routes (`api.publicRoutes.serve`).
    readonly publicHandler: () => PublicRouteHandler | undefined;
    readonly tools: () => ToolSource | undefined;
    readonly performer: () => ApprovedActionHandler | undefined;
    // (2026-11-26) What publishes the approved posts its cards declare (`api.approvals.publish`).
    readonly publisher: () => ApprovedPostHandler | undefined;
    readonly fireHandler: (name: string) => AutomationFireHandler | undefined;
    readonly checkHandler: (kind: string) => WatchCheckHandler | undefined;
    close(): void;
}

// The handlers automations fire, by name: only a name the manifest declares (`permissions.fires`), and a handler
// disposed lets go of its name only while it is still the one registered.
const createFireHandlers = (id: string, declared: readonly string[]) => {
    const handlers = new Map<string, AutomationFireHandler>();
    return {
        onFire: (name: string, listener: AutomationFireHandler): Disposable => {
            if (!EXTENSION_FIRE_HANDLER.test(name) || !declared.includes(name)) {
                throw new Error(`extension "${id}" registered the fire handler "${name}" without declaring it: declare it in permissions.fires in its manifest`);
            }
            handlers.set(name, listener);
            return {
                dispose: () => {
                    if (handlers.get(name) === listener) {
                        handlers.delete(name);
                    }
                },
            };
        },
        handler: (name: string): AutomationFireHandler | undefined => handlers.get(name),
    };
};

// The checks a backend serves, by kind: only a kind the manifest declares (`contributes.watchKinds`), and a handler
// disposed lets go of its kind only while it is still the one registered.
const createCheckHandlers = (id: string, declared: readonly string[]) => {
    const handlers = new Map<string, WatchCheckHandler>();
    return {
        serve: (kind: string, handler: WatchCheckHandler): Disposable => {
            if (!declared.includes(kind)) {
                throw new Error(`extension "${id}" served the watch kind "${kind}" without declaring it: declare it in contributes.watchKinds in its manifest`);
            }
            handlers.set(kind, handler);
            return {
                dispose: () => {
                    if (handlers.get(kind) === handler) {
                        handlers.delete(kind);
                    }
                },
            };
        },
        handler: (kind: string): WatchCheckHandler | undefined => handlers.get(kind),
    };
};

export const createServerApi = (options: ExtensionRuntimeOptions): ServerApiSlots => {
    const runtime = createExtensionRuntime(options);
    // (2026-11-26) What its tools do with the calling turn's grants (turn-reach.ts).
    const turn = createTurnReach(options.id, runtime.api.daemon.request, (options.declared ?? NO_DECLARED_REACH).turn, runtime.api.log);
    let mounted: BackendRouteHandler | undefined;
    let publicHandler: PublicRouteHandler | undefined;
    let tools: ToolSource | undefined;
    let performer: ApprovedActionHandler | undefined;
    let publisher: ApprovedPostHandler | undefined;
    const fires = createFireHandlers(options.id, (options.declared ?? NO_DECLARED_REACH).fires);
    const checks = createCheckHandlers(options.id, options.watchKinds ?? []);
    return {
        api: {
            ...runtime.api,
            routes: {
                mount: (handler) => {
                    mounted = handler;
                },
            },
            caller: (request) => callerOf(request, options.id),
            publicRoutes: {
                serve: (handler) => {
                    publicHandler = handler;
                },
            },
            tools: {
                serve: (source) => {
                    tools = source;
                },
            },
            approvals: {
                perform: (handler) => {
                    performer = handler;
                },
                publish: (handler) => {
                    publisher = handler;
                },
            },
            automations: { onFire: fires.onFire },
            checks: { serve: checks.serve },
            browser: turn.browser,
            ownerBrowser: turn.ownerBrowser,
            jobs: turn.jobs,
        },
        handler: () => mounted,
        publicHandler: () => publicHandler,
        tools: () => tools,
        performer: () => performer,
        publisher: () => publisher,
        fireHandler: fires.handler,
        checkHandler: checks.handler,
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
        }, DEACTIVATE_DEADLINE_MS, "late" as const, { unref: true });
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
        const answer = await within(health, HEALTH_DEADLINE_MS, late, { unref: true });
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

// The declared reach a process was started with; nothing declared when the variable is absent (a daemon from before it).
const declaredOf = (raw: string | undefined): ExtensionDeclaredReach => {
    if (raw === undefined || raw === "") {
        return NO_DECLARED_REACH;
    }
    const parsed = ExtensionDeclaredReachSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
        throw new Error(`${EXTENSION_PROCESS_ENV.declared} is not the JSON of a declared reach`);
    }
    return parsed.data;
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
        declared: declaredOf(env[EXTENSION_PROCESS_ENV.declared]),
    });
