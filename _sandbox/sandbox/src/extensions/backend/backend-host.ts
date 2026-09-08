import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { errorMessage } from "@intentic/base/errors";
import type { BackendRouteHandler, ExtensionServerApi, ExtensionServerModule } from "@intentic/extension-api";
import {
    BACKEND_HOST_HEADER,
    type BackendExtensionStatus,
    type BackendHostConfig,
    type BackendHostExtension,
    EXTENSION_TOKEN_HEADER,
} from "./backend-host-config.js";

// The backend host's whole runtime as a pure function of its config; testable without a spawn.
// Runs in the child process: must not import the daemon's services, store, or logger; only stdout and /health talk
// back.
// Each extension loads in its own try/catch and is reported per id; the host has no restart logic, dying is its
// teardown.

interface LoadedExtension {
    readonly status: BackendExtensionStatus;
    readonly handler?: BackendRouteHandler;
}

// Resolves activateServer from a default export or named exports, matching the web loader's tolerance for UI bundles.
const resolveModule = (imported: Partial<ExtensionServerModule> & { default?: ExtensionServerModule }): ExtensionServerModule => {
    const resolved = imported.default ?? imported;
    if (typeof resolved.activateServer !== "function") {
        throw new Error("the server bundle exports no activateServer(api, context)");
    }
    return resolved as ExtensionServerModule;
};

const loadOne = async (config: BackendHostConfig, extension: BackendHostExtension): Promise<LoadedExtension> => {
    // Mount slot; a second call to mount replaces the first, per the API contract.
    let mounted: BackendRouteHandler | undefined;
    const api: ExtensionServerApi = {
        apiVersion: config.apiVersion,
        workspaceRoot: config.workspaceRoot,
        extensionDir: extension.dir,
        // stdout is the only channel back to the daemon log; the prefix attributes the line to this extension.
        log: (message) => console.log(`[${extension.id}] ${message}`),
        routes: {
            mount: (handler) => {
                mounted = handler;
            },
        },
        daemon: {
            request: (path, init) => {
                const headers = new Headers(init?.headers);
                headers.set(EXTENSION_TOKEN_HEADER, extension.daemonToken);
                return fetch(`${config.daemonUrl}${path}`, { ...init, headers });
            },
            json: async <T>(path: string, init?: RequestInit): Promise<T> => {
                const headers = new Headers(init?.headers);
                headers.set(EXTENSION_TOKEN_HEADER, extension.daemonToken);
                if (init?.body !== undefined && !headers.has("content-type")) {
                    headers.set("content-type", "application/json");
                }
                const response = await fetch(`${config.daemonUrl}${path}`, { ...init, headers });
                if (!response.ok) {
                    throw new Error(`daemon answered ${response.status} for ${init?.method ?? "GET"} ${path}: ${await response.text()}`);
                }
                return (await response.json()) as T;
            },
        },
    };
    try {
        const imported = (await import(pathToFileURL(join(extension.dir, extension.server)).href)) as Partial<ExtensionServerModule> & {
            default?: ExtensionServerModule;
        };
        await resolveModule(imported).activateServer(api, { extensionId: extension.id });
    } catch (error) {
        return { status: { id: extension.id, state: "error", detail: errorMessage(error) } };
    }
    return {
        status: { id: extension.id, state: "running" },
        // Activating without mounting a route is legal (timers only); unmounted requests answer 404.
        ...(mounted !== undefined ? { handler: mounted } : {}),
    };
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
    readonly statuses: readonly BackendExtensionStatus[];
}

export const createBackendHostApp = async (config: BackendHostConfig): Promise<BackendHostApp> => {
    const loaded = new Map<string, LoadedExtension>();
    for (const extension of config.extensions) {
        loaded.set(extension.id, await loadOne(config, extension));
    }
    const statuses = [...loaded.values()].map((extension) => extension.status);
    return {
        statuses,
        fetch: async (request) => {
            // Accepts only daemon-proxied requests: loopback is shared and credential checks live in the daemon's gate.
            if (request.headers.get(BACKEND_HOST_HEADER) !== config.hostToken) {
                return json({ error: "unauthorized" }, 401);
            }
            const url = new URL(request.url);
            if (request.method === "GET" && url.pathname === "/health") {
                return json({ ok: true, extensions: statuses }, 200);
            }
            const target = splitNamespace(url.pathname);
            if (target === undefined) {
                return json({ error: "not found" }, 404);
            }
            const extension = loaded.get(target.id);
            if (extension === undefined) {
                return json({ error: `no backend for extension "${target.id}"` }, 404);
            }
            if (extension.handler === undefined) {
                const detail = extension.status.state === "error" ? ` (its activation failed: ${extension.status.detail})` : "";
                return json({ error: `the "${target.id}" backend serves no routes${detail}` }, 404);
            }
            // Rebases onto the extension's own synthetic origin; owner credentials and the host token are already
            // stripped.
            const headers = new Headers(request.headers);
            headers.delete(BACKEND_HOST_HEADER);
            const body = request.method === "GET" || request.method === "HEAD" ? undefined : request.body;
            const rebased = new Request(new URL(`${target.suffix}${url.search}`, "http://extension.internal"), {
                method: request.method,
                headers,
                ...(body !== undefined ? { body, duplex: "half" } : {}),
            } as RequestInit);
            try {
                return (await extension.handler(rebased)) ?? json({ error: "not found" }, 404);
            } catch (error) {
                // Contained like an activation failure: a throwing route answers 500; the host stays up.
                return json({ error: errorMessage(error) }, 500);
            }
        },
    };
};
