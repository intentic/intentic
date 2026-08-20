/* THE OBSIDIAN LOCAL REST API, as much of it as this connector needs.
 *
 * The vault is not a folder this sandbox can see: it lives in the Obsidian window on the owner's own machine,
 * and the community "Local REST API" plugin is the only door into it that works while the app is open and
 * whatever the owner syncs with is running. So every read and write here is one HTTP call to that plugin,
 * bearer-authenticated with the key it shows in its settings.
 *
 * TWO THINGS ABOUT THE TRANSPORT that are not incidental:
 *
 * 1. THE HOST IS `host.docker.internal`, not localhost. This sandbox is a container; the vault is on the
 *    machine hosting it. The card's default says so, because "localhost" is the answer everybody tries first
 *    and it fails with a connection refused that names nothing.
 * 2. THE CERTIFICATE IS SELF-SIGNED, always. The plugin mints its own CA on first run and serves https on
 *    27124 with it, so certificate verification cannot succeed unless the owner installs that CA, which is a
 *    step nobody takes to reach their own laptop. Verification is therefore switched off for https, and only
 *    for the https case, in a process whose entire life is talking to that one address. Said out loud here
 *    rather than buried, because "TLS off" deserves to be a sentence somebody can disagree with.
 *
 * The note bodies cross as PLAIN MARKDOWN (the plugin can return parsed JSON instead; it is not asked to), so
 * the knowledge base's own parser is what reads a vault note, one reader, one link resolver, one idea of what
 * a note says, whether the file sits in the workspace or in the owner's vault. */

import type { VaultConnection } from "./connection.js";

// One failed call, in the terms the caller has to print. `status` is undefined when the request never landed.
export interface VaultError {
    readonly error: string;
    readonly status?: number | undefined;
}

export const isVaultError = <T>(value: T | VaultError): value is VaultError =>
    typeof value === "object" && value !== null && "error" in (value as Record<string, unknown>);

/* Certificate verification, off for https and nothing else. Node reads this at connection time and offers no
 * per-request override without reaching for undici internals the self-contained CLI bundle cannot import, so
 * it is a process-level switch, flipped once, by a process that dials one host. */
export const relaxTlsFor = (url: string, env: Record<string, string | undefined>): void => {
    if (url.toLowerCase().startsWith("https://")) {
        env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    }
};

// Each path segment encoded, the slashes left alone, a note called "Q&A/2026.md" is a real path with a real
// separator, and encodeURIComponent over the whole thing would turn it into one filename with a slash in it.
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
            return "the API key was refused — copy it again from Obsidian ▸ Settings ▸ Local REST API";
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

/* Every call goes through here, so the four things that are true of all of them, the bearer header, the
 * self-signed certificate, an unreachable Obsidian, a non-2xx answer, are handled once and phrased once.
 *
 * A DEAD CONNECTION IS THE COMMON FAILURE, not a rare one: the owner closed Obsidian, or never turned the
 * plugin on. That is the message worth spending words on, because it is the one the reader can act on and the
 * one a raw fetch error ("fetch failed") describes worst. */
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
                `couldn't reach Obsidian at ${vault.url} (${error instanceof Error ? error.message : String(error)}).`,
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

// ---- the calls ---------------------------------------------------------------------------------------------

// Whether the door opens at all, and what is behind it. The plugin answers this one unauthenticated too, but it
// is sent WITH the key on purpose: "reachable" and "reachable and authorised" are different states of a card.
export const vaultInfo = async (vault: VaultConnection): Promise<{ readonly service?: string; readonly authenticated?: boolean } | VaultError> =>
    await json(vault, { method: "GET", path: "/" });

// One directory. Obsidian answers with names relative to it, directories carrying a trailing slash. Not
// exported: `vaultWalk` below is the only sensible way to ask this question, since one call answers for one
// level and a vault is a tree.
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

// Bring a note to the front in the owner's own window, the one verb here that is for the PERSON rather than
// for the agent, and the reason the agent can say "look at this" instead of "open the file called…".
export const vaultOpen = async (vault: VaultConnection, file: string): Promise<undefined | VaultError> => {
    const result = await vaultCall(vault, { method: "POST", path: `/open/${encodeVaultPath(file)}` });
    return isVaultError(result) ? result : undefined;
};

export interface VaultHit {
    readonly filename: string;
    readonly score?: number | undefined;
    readonly matches?: readonly { readonly context?: string }[] | undefined;
}

// The plugin's plain text search. Its richer Dataview/JsonLogic endpoint is deliberately not wired: it needs a
// query language the agent would have to be taught, to answer questions the knowledge graph answers better
// once the notes are pulled in.
export const vaultSearch = async (vault: VaultConnection, query: string, contextLength: number): Promise<readonly VaultHit[] | VaultError> => {
    const result = await json<readonly VaultHit[]>(vault, {
        method: "POST",
        path: `/search/simple/?query=${encodeURIComponent(query)}&contextLength=${contextLength}`,
    });
    return isVaultError(result) ? result : result;
};

/* Every markdown file in the vault, walked. The plugin lists one directory per call, so this is a breadth-first
 * walk rather than one request, and it skips the directories a vault keeps that hold no notes, the same set
 * the workspace-side reader skips, so "what is in the vault" means the same thing on both sides. */
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
