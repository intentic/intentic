import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOpencodeClient, createOpencodeServer, type OpencodeClient } from "@opencode-ai/sdk";
import { discoverXaiModels } from "./grok-models.js";

/* The shared OpenCode runtime for the Grok provider: one warm `opencode serve` per container plus its client.
 * Both the Grok adapter (runs turns) and the Grok auth routes (drive xAI's OAuth) need the same client, so
 * ownership lives here rather than inside the adapter. Single-tenant (one container per project), so one server
 * is enough.
 *
 * OpenCode is also the credential store — it persists the xAI OAuth tokens and refreshes them itself, so there
 * is no ClaudeStore/CodexStore twin. We pin its data dir to the workspace (XDG_DATA_HOME) so those tokens
 * survive daemon restarts, and `connected()`/`disconnect()` read/clear that store. */
export interface OpenCodeService {
    // Ensure the server is up and return its client (lazy: the first turn or auth call boots it).
    readonly client: () => Promise<OpencodeClient>;
    // Whether the given provider (e.g. "xai") is authenticated — read from OpenCode's persisted auth store on disk
    // (the ground truth a device sign-in writes), NOT provider.list().connected, which OpenCode computes once at
    // server-init and never refreshes after a runtime auth.set() on our long-lived server.
    readonly connected: (providerID: string) => Promise<boolean>;
    // xAI's live model catalog (id + label) plus a default id, queried from xAI's /v1/models with the OAuth token
    // OpenCode persisted — supersedes provider.list() as the model source, since that catalog is a static
    // models.dev snapshot whose xai models can be empty and whose default can be a retired id (grok-code-fast-1)
    // xAI rejects. Empty ⇒ no token (not connected). Cached briefly (grok turns + the Claude delegation note both
    // read it every turn).
    readonly xaiModels: () => Promise<{ models: { id: string; label: string }[]; default?: string }>;
    // Clear a provider's stored auth. No provider-scoped SDK removal exists, so we delete OpenCode's auth store
    // (this instance is Grok-only). ponytail: file-level clear; swap for an SDK call if one lands.
    readonly disconnect: (providerID: string) => Promise<void>;
}

export const createOpenCodeService = (xdgDataHome: string): OpenCodeService => {
    let client: OpencodeClient | undefined;
    // xAI's catalog rarely changes, so cache it briefly: a grok turn AND every Claude turn's delegation note read
    // it, and each read is an api.x.ai round-trip. Only a token-backed result is cached — an empty (not-connected)
    // result stays uncached so the first read after sign-in refetches. Cleared on disconnect.
    let modelsCache: { value: { models: { id: string; label: string }[]; default?: string }; expiresAt: number } | undefined;
    const MODELS_TTL_MS = 60_000;
    const authPath = join(xdgDataHome, "opencode", "auth.json");

    const ensure = async (): Promise<OpencodeClient> => {
        if (client !== undefined) {
            return client;
        }
        // createOpencodeServer spawns `opencode serve` inheriting process.env (it exposes no env option), so pin
        // XDG_DATA_HOME across the synchronous spawn only — the child captures it at launch; restoring right
        // after keeps the daemon's other subprocess spawns (Claude/Codex) unaffected.
        const previous = process.env["XDG_DATA_HOME"];
        process.env["XDG_DATA_HOME"] = xdgDataHome;
        let server: { url: string; close(): void };
        try {
            server = await createOpencodeServer({
                // No provider key — xAI auth is OAuth (stored by OpenCode). Run autonomously: the container IS the
                // isolation boundary (same posture as Claude's bypassPermissions / Codex's danger-full-access).
                config: { permission: { edit: "allow", bash: "allow", webfetch: "allow" } },
            });
        } finally {
            if (previous === undefined) {
                delete process.env["XDG_DATA_HOME"];
            } else {
                process.env["XDG_DATA_HOME"] = previous;
            }
        }
        client = createOpencodeClient({ baseUrl: server.url });
        return client;
    };

    // OpenCode's persisted Auth store — each provider keyed at the top level:
    // { xai: { type: "oauth", access, refresh, expires } }. {} when absent/unreadable.
    const readAuth = async (): Promise<Record<string, { type?: string; access?: string } | undefined>> => {
        try {
            return JSON.parse(await readFile(authPath, "utf8")) as Record<string, { type?: string; access?: string } | undefined>;
        } catch {
            return {};
        }
    };
    // The xAI subscription OAuth access token OpenCode persisted. undefined ⇒ no token yet / not connected.
    const xaiAccessToken = async (): Promise<string | undefined> => {
        const entry = (await readAuth())["xai"];
        return entry?.type === "oauth" && typeof entry.access === "string" ? entry.access : undefined;
    };

    return {
        client: ensure,
        connected: async (providerID) => {
            // Read the persisted credential directly, NOT provider.list().connected: OpenCode computes that set
            // once at server-init and never refreshes it after a runtime auth.set(), so on our single long-lived
            // `opencode serve` a just-completed device sign-in never flips it. auth.json is what the flow writes.
            const entry = (await readAuth())[providerID];
            return entry?.type === "oauth" && typeof entry.access === "string";
        },
        xaiModels: async () => {
            if (modelsCache !== undefined && Date.now() < modelsCache.expiresAt) {
                return modelsCache.value;
            }
            const token = await xaiAccessToken();
            if (token === undefined) {
                return { models: [] };
            }
            const models = await discoverXaiModels(token);
            const value = { models, ...(models[0] !== undefined ? { default: models[0].id } : {}) };
            modelsCache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
            return value;
        },
        disconnect: async () => {
            modelsCache = undefined;
            await rm(authPath, { force: true });
        },
    };
};
