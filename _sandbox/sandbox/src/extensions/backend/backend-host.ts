import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { errorMessage } from "@intentic/base/errors";
import type { ExtensionServerModule, ServerActivation } from "@intentic/extension-api";
import { activateServerModule, createServerApi, deactivateWithin, healthWithin, type ServerApiSlots } from "@intentic/extension-api/runtime";
import { tokenEquals } from "../../auth/token-equals.js";
import { answerToolMessage, type ToolRequest } from "./backend-tools.js";
import {
    BACKEND_HOST_HEADER,
    type BackendDeviceConfig,
    type BackendExtensionStatus,
    type BackendHostExtension,
    type BackendReload,
} from "./backend-host-config.js";

// The backend host's whole runtime as a pure function of its config; testable without a spawn.
// Runs in the child process: must not import the daemon's services, store, or logger; only stdout and /health talk
// back.
// Each extension loads in its own try/catch and is reported per id. An extension that hands back a `deactivate` can be
// let go of and loaded again in place (POST /reload), so a change to it alone leaves every other backend running; one
// that does not is only ever replaced by the host's own restart. On SIGTERM every activation is deactivated, under the
// deadline, before the host exits (drain).

const moduleCache = createRequire(import.meta.url).cache;

interface LoadedExtension {
    readonly extension: BackendHostExtension;
    readonly status: BackendExtensionStatus;
    readonly slots?: ServerApiSlots;
    readonly activation?: ServerActivation;
}

// What a reload compares to decide an extension changed: everything it is handed at activation and the code it runs.
const activationKeyOf = (extension: BackendHostExtension): string =>
    JSON.stringify({
        dir: extension.dir,
        server: extension.server,
        bundle: extension.bundle,
        stateDir: extension.stateDir,
        cacheDir: extension.cacheDir,
        daemonToken: extension.daemonToken,
        daemonPermissions: [...extension.daemonPermissions].toSorted(),
    });

const loadOne = async (config: BackendDeviceConfig, extension: BackendHostExtension): Promise<LoadedExtension> => {
    const slots = createServerApi({
        id: extension.id,
        daemonUrl: config.daemonUrl,
        token: extension.daemonToken,
        permissions: extension.daemonPermissions,
        workspaceRoot: config.workspaceRoot,
        extensionDir: extension.dir,
        stateDir: extension.stateDir,
        cacheDir: extension.cacheDir,
    });
    try {
        // A reload must import the new code, and the two runtimes cache a module differently: Node by its whole URL, so
        // the digest in the query is a new module; Bun by its path alone, so its entry is dropped first (Node keeps ESM
        // out of require.cache, where the delete is a no-op).
        const file = join(extension.dir, extension.server);
        delete moduleCache[file];
        const url = `${pathToFileURL(file).href}?v=${encodeURIComponent(extension.bundle)}`;
        const imported = (await import(url)) as Partial<ExtensionServerModule> & { default?: ExtensionServerModule };
        const activation = await activateServerModule(imported, slots.api, { extensionId: extension.id });
        return { extension, slots, activation, status: { id: extension.id, state: "running", ...(activation.deactivate === undefined ? {} : { reloadable: true }) } };
    } catch (error) {
        slots.close();
        // Whatever a failed activation started before it threw has nothing to stop it, so only a restart replaces it.
        return { extension, status: { id: extension.id, state: "error", detail: errorMessage(error) } };
    }
};

// Lets one activation go: its own deactivate under the deadline, then what the runtime held open for it.
const unload = async (loaded: LoadedExtension): Promise<void> => {
    if (loaded.activation !== undefined) {
        await deactivateWithin(loaded.activation, (message) => console.log(`[${loaded.extension.id}] ${message}`));
    }
    loaded.slots?.close();
};

const json = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// Splits /x/<id>/<suffix> into the extension id and its own path ("" becomes "/"); the query string stays on the
// suffix.
const splitNamespace = (pathname: string): { id: string; suffix: string } | undefined => {
    const match = /^\/x\/([^/]+)(\/.*)?$/.exec(pathname);
    if (match === null || match[1] === undefined) {
        return undefined;
    }
    return { id: decodeURIComponent(match[1]), suffix: match[2] === undefined || match[2] === "" ? "/" : match[2] };
};

export interface BackendHostApp {
    readonly fetch: (request: Request) => Promise<Response>;
    // Each extension's activation outcome, without asking any of them about their health.
    readonly statuses: readonly BackendExtensionStatus[];
    // Deactivates every activation, each under the deadline and all at once; the host exits after it.
    readonly drain: () => Promise<void>;
}

export const createBackendHostApp = async (config: BackendDeviceConfig): Promise<BackendHostApp> => {
    const loaded = new Map<string, LoadedExtension>();
    for (const extension of config.extensions) {
        loaded.set(extension.id, await loadOne(config, extension));
    }
    // Extensions being let go of or loaded again right now: their routes answer 503 rather than a stale or absent backend.
    const reloading = new Set<string>();
    // One reload at a time: a second waits for the first rather than interleaving with it.
    let reloads: Promise<unknown> = Promise.resolve();

    const statuses = (): BackendExtensionStatus[] => [...loaded.values()].map((each) => each.status);

    // Every running extension asked how it is, all at once, each under the health deadline. An `ok` with nothing to say
    // is the row's default and is left off it.
    const healthReport = async (): Promise<BackendExtensionStatus[]> =>
        Promise.all(
            [...loaded.values()].map(async (each) => {
                if (each.activation === undefined || each.status.state !== "running") {
                    return each.status;
                }
                const health = await healthWithin(each.activation);
                return health.state === "ok" && health.detail === undefined ? each.status : { ...each.status, health };
            }),
        );

    const reload = async (wanted: readonly BackendHostExtension[]): Promise<Response> => {
        const next = new Map(wanted.map((extension) => [extension.id, extension]));
        const leaving = [...loaded.values()].filter((each) => {
            const replacement = next.get(each.extension.id);
            return replacement === undefined || activationKeyOf(replacement) !== activationKeyOf(each.extension);
        });
        const held = leaving.filter((each) => each.status.reloadable !== true).map((each) => each.extension.id);
        if (held.length > 0) {
            return json({ error: `${held.join(", ")} cannot be replaced in place: it hands back no deactivate`, held }, 409);
        }
        const arriving = wanted.filter((extension) => !loaded.has(extension.id) || leaving.some((each) => each.extension.id === extension.id));
        for (const id of new Set([...leaving.map((each) => each.extension.id), ...arriving.map((extension) => extension.id)])) {
            reloading.add(id);
        }
        try {
            await Promise.all(
                leaving.map(async (each) => {
                    await unload(each);
                    loaded.delete(each.extension.id);
                }),
            );
            for (const extension of arriving) {
                loaded.set(extension.id, await loadOne(config, extension));
            }
        } finally {
            reloading.clear();
        }
        return json({ ok: true, extensions: statuses() }, 200);
    };

    // POST /reload: the set the host should run now, one reload at a time.
    const answerReload = async (request: Request): Promise<Response> => {
        // SAFETY: a JSON body or undefined, from the supervisor of this build (backend-supervisor.ts); its one field is
        // checked to be an array just below.
        // allow(silent-catch): a body that is not JSON is answered as the 400 just below
        const body = (await request.json().catch(() => undefined)) as BackendReload | undefined;
        if (!Array.isArray(body?.extensions)) {
            return json({ error: "a reload carries { extensions }" }, 400);
        }
        const answer = reloads.then(() => reload(body.extensions));
        // allow(silent-catch): the queue only orders the next reload behind this one; this one's caller gets its answer
        reloads = answer.catch(() => undefined);
        return answer;
    };

    // Where an extension's code answers: its loaded entry, or the refusal to answer instead.
    const loadedOr = (id: string): LoadedExtension | Response => {
        if (reloading.has(id)) {
            return json({ error: `the "${id}" backend is reloading` }, 503);
        }
        return loaded.get(id) ?? json({ error: `no backend for extension "${id}"` }, 404);
    };

    // POST /tools/<id>: an extension's tools, reached only from the daemon's MCP door with the card it resolved: one
    // JSON-RPC message in, its answer out. Never under /x, which is reachable with a person's or a panel's bearer.
    const answerTools = async (id: string, request: Request): Promise<Response> => {
        const extension = loadedOr(id);
        if (extension instanceof Response) {
            return extension;
        }
        // SAFETY: a JSON body or undefined, from the daemon's MCP door; its one required field is checked just below.
        // allow(silent-catch): a body that is not JSON is answered as the 400 just below
        const body = (await request.json().catch(() => undefined)) as ToolRequest | undefined;
        if (body?.message === undefined) {
            return json({ error: "a tools request carries { card?, conversationId?, message }" }, 400);
        }
        const answer = await answerToolMessage({ id, source: extension.slots?.tools() }, body, request.signal);
        return json({ answer: answer ?? null }, 200);
    };

    // /x/<id>/<suffix>: the extension's own namespace, rebased onto its own synthetic origin with owner credentials and
    // the host token already stripped.
    const answerNamespace = async (target: { readonly id: string; readonly suffix: string }, url: URL, request: Request): Promise<Response> => {
        const extension = loadedOr(target.id);
        if (extension instanceof Response) {
            return extension;
        }
        const handler = extension.slots?.handler();
        if (handler === undefined) {
            const detail = extension.status.state === "error" ? ` (its activation failed: ${extension.status.detail})` : "";
            return json({ error: `the "${target.id}" backend serves no routes${detail}` }, 404);
        }
        const headers = new Headers(request.headers);
        headers.delete(BACKEND_HOST_HEADER);
        const init: RequestInit & { duplex?: "half" } = { method: request.method, headers };
        if (request.method !== "GET" && request.method !== "HEAD" && request.body !== null) {
            init.body = request.body;
            init.duplex = "half";
        }
        try {
            return (await handler(new Request(new URL(`${target.suffix}${url.search}`, "http://extension.internal"), init))) ?? json({ error: "not found" }, 404);
        } catch (error) {
            // Contained like an activation failure: a throwing route answers 500; the host stays up.
            return json({ error: errorMessage(error) }, 500);
        }
    };

    return {
        get statuses() {
            return statuses();
        },
        drain: async () => {
            await Promise.all([...loaded.values()].map(unload));
        },
        fetch: async (request) => {
            // Accepts only daemon-proxied requests: loopback is shared and credential checks live in the daemon's gate.
            // Compared in constant time, and an empty host token admits nobody.
            if (config.hostToken === "" || !tokenEquals(request.headers.get(BACKEND_HOST_HEADER) ?? "", config.hostToken)) {
                return json({ error: "unauthorized" }, 401);
            }
            const url = new URL(request.url);
            // Plain: whether the host answers, and each activation's outcome, which the readiness wait polls fast. `?deep`:
            // each backend's own health check too, under its deadline, which the supervisor's sweep asks for.
            if (request.method === "GET" && url.pathname === "/health") {
                return json({ ok: true, extensions: url.searchParams.has("deep") ? await healthReport() : statuses() }, 200);
            }
            if (request.method === "POST" && url.pathname === "/reload") {
                return answerReload(request);
            }
            const toolsOf = /^\/tools\/([^/]+)$/.exec(url.pathname)?.[1];
            if (request.method === "POST" && toolsOf !== undefined) {
                return answerTools(decodeURIComponent(toolsOf), request);
            }
            const target = splitNamespace(url.pathname);
            return target === undefined ? json({ error: "not found" }, 404) : answerNamespace(target, url, request);
        },
    };
};
