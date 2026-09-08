// Talks to the Obsidian Local REST API plugin over HTTP, bearer-authenticated, at host.docker.internal (the vault lives
// outside this sandbox). The plugin's certificate is self-signed, so TLS verification is off for it. Note bodies come
// back as plain markdown, not the plugin's parsed JSON.

import { errorMessage } from "@intentic/base/errors";
import type { VaultConnection } from "./connection.js";

// One failed call, in terms the caller can print; `status` is undefined when the request never landed.
export interface VaultError {
    readonly error: string;
    readonly status?: number | undefined;
}

export const isVaultError = <T>(value: T | VaultError): value is VaultError =>
    typeof value === "object" && value !== null && "error" in (value as Record<string, unknown>);

// Disables TLS verification for https only; process-level, not per-request: Node has no finer-grained switch.
export const relaxTlsFor = (url: string, env: Record<string, string | undefined>): void => {
    if (url.toLowerCase().startsWith("https://")) {
        env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    }
};

// Encodes each path segment, leaving `/` separators alone; encodeURIComponent over the whole path would escape them
// too.
export const encodeVaultPath = (path: string): string =>
    path
        .split("/")
        .filter((segment) => segment !== "")
        .map((segment) => encodeURIComponent(segment))
        .join("/");

interface Call {
    readonly method: string;
    readonly path: string;
    readonly body?: string | undefined;
    readonly contentType?: string | undefined;
    readonly accept?: string | undefined;
}

const describe = (status: number, path: string): string => {
    switch (status) {
        case 401:
        case 403: {
            return "the API key was refused: copy it again from Obsidian ▸ Settings ▸ Local REST API";
        }
        case 404: {
            return `the vault has nothing at "${path}"`;
        }
        case 405: {
            return `the vault refused that operation on "${path}"`;
        }
        default: {
            return `the vault answered ${status}`;
        }
    }
};

// Single choke point for the bearer header, TLS, an unreachable Obsidian, and a non-2xx response; a closed Obsidian is
// treated as the common failure, not a rare one.
export const vaultCall = async (vault: VaultConnection, call: Call): Promise<string | VaultError> => {
    if (vault.problem !== undefined) {
        return { error: vault.problem };
    }
    let response: Response;
    try {
        response = await fetch(`${vault.url}${call.path}`, {
            method: call.method,
            headers: {
                authorization: `Bearer ${vault.apiKey}`,
                ...(call.contentType === undefined ? {} : { "content-type": call.contentType }),
                ...(call.accept === undefined ? {} : { accept: call.accept }),
            },
            body: call.body,
        });
    } catch (error) {
        return {
            error: [
                `couldn't reach Obsidian at ${vault.url} (${errorMessage(error)}).`,
                "Obsidian has to be OPEN on that machine with the Local REST API plugin enabled.",
                "From a sandbox the address is host.docker.internal, never localhost.",
            ].join(" "),
        };
    }
    if (!response.ok) {
        return { error: describe(response.status, call.path), status: response.status };
    }
    return await response.text();
};

const json = async <T>(vault: VaultConnection, call: Call): Promise<T | VaultError> => {
    const raw = await vaultCall(vault, call);
    if (isVaultError(raw)) {
        return raw;
    }
    try {
        return JSON.parse(raw) as T;
    } catch {
        return { error: `the vault answered something that isn't JSON: ${raw.slice(0, 120)}` };
    }
};

// the calls

// Reachability and identity of the plugin. Sent with the key even though the endpoint doesn't require one: reachable
// and authorised are different states.
export const vaultInfo = async (vault: VaultConnection): Promise<{ readonly service?: string; readonly authenticated?: boolean } | VaultError> =>
    await json(vault, { method: "GET", path: "/" });

// One directory: names relative to it, directories with a trailing slash. Not exported; `vaultWalk` is the tree-walking
// entry point.
const vaultList = async (vault: VaultConnection, folder: string): Promise<readonly string[] | VaultError> => {
    const encoded = encodeVaultPath(folder);
    const result = await json<{ files?: readonly string[] }>(vault, { method: "GET", path: `/vault/${encoded === "" ? "" : `${encoded}/`}` });
    return isVaultError(result) ? result : (result.files ?? []);
};

export const vaultRead = async (vault: VaultConnection, file: string): Promise<string | VaultError> =>
    await vaultCall(vault, { method: "GET", path: `/vault/${encodeVaultPath(file)}`, accept: "text/markdown" });

export const vaultWrite = async (vault: VaultConnection, file: string, content: string): Promise<undefined | VaultError> => {
    const result = await vaultCall(vault, { method: "PUT", path: `/vault/${encodeVaultPath(file)}`, body: content, contentType: "text/markdown" });
    return isVaultError(result) ? result : undefined;
};

export const vaultAppend = async (vault: VaultConnection, file: string, content: string): Promise<undefined | VaultError> => {
    const result = await vaultCall(vault, { method: "POST", path: `/vault/${encodeVaultPath(file)}`, body: content, contentType: "text/markdown" });
    return isVaultError(result) ? result : undefined;
};

export const vaultDelete = async (vault: VaultConnection, file: string): Promise<undefined | VaultError> => {
    const result = await vaultCall(vault, { method: "DELETE", path: `/vault/${encodeVaultPath(file)}` });
    return isVaultError(result) ? result : undefined;
};

// Brings a note to the front of the owner's own Obsidian window; the one verb here meant for the person, not the agent.
export const vaultOpen = async (vault: VaultConnection, file: string): Promise<undefined | VaultError> => {
    const result = await vaultCall(vault, { method: "POST", path: `/open/${encodeVaultPath(file)}` });
    return isVaultError(result) ? result : undefined;
};

export interface VaultHit {
    readonly filename: string;
    readonly score?: number | undefined;
    readonly matches?: readonly { readonly context?: string }[] | undefined;
}

// Plain text search only. The Dataview/JsonLogic endpoint is not wired: the knowledge graph answers structured queries
// once notes are pulled in.
export const vaultSearch = async (vault: VaultConnection, query: string, contextLength: number): Promise<readonly VaultHit[] | VaultError> => {
    const result = await json<readonly VaultHit[]>(vault, {
        method: "POST",
        path: `/search/simple/?query=${encodeURIComponent(query)}&contextLength=${contextLength}`,
    });
    return isVaultError(result) ? result : result;
};

// Breadth-first, one level per `vaultList` call; skips directories the workspace reader also skips.
const SKIP_DIRS = new Set([".obsidian", ".trash", ".git"]);

export const vaultWalk = async (vault: VaultConnection, folder = ""): Promise<readonly string[] | VaultError> => {
    const found: string[] = [];
    const queue = [folder];
    while (queue.length > 0) {
        const dir = queue.shift() ?? "";
        const entries = await vaultList(vault, dir);
        if (isVaultError(entries)) {
            // A folder that vanished mid-walk is not a failed walk; a first call that fails is.
            if (dir === folder) {
                return entries;
            }
            continue;
        }
        for (const entry of entries) {
            const path = dir === "" ? entry : `${dir}/${entry}`;
            if (entry.endsWith("/")) {
                if (!SKIP_DIRS.has(entry.replace(/\/$/, ""))) {
                    queue.push(path.replace(/\/$/, ""));
                }
                continue;
            }
            if (entry.toLowerCase().endsWith(".md")) {
                found.push(path);
            }
        }
    }
    return found.toSorted((a, b) => a.localeCompare(b));
};
