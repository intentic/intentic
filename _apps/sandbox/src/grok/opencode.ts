import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareUnrankedModelIds } from "@intentic/sandbox-contract";
import { createOpencodeClient, createOpencodeServer, type OpencodeClient } from "@opencode-ai/sdk";
import { discoverXaiModels, humanizeModelId, isChatModel, SEED_XAI_MODELS } from "./grok-models.js";

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
    // Whether OpenCode still holds this session — the resume pre-flight every other provider already had (see
    // turn-plan.ts). Without it a chat whose session OpenCode lost (its storage cleared, a sandbox rebuild) sent
    // its prompt at a dead id and got the raw rejection back, forever: nothing told the client the id was the
    // problem, so every retry re-sent the same one. False on an unreachable server too — the turn that follows
    // starts a fresh session, which is the same recovery and a better failure than a wedged conversation.
    readonly sessionExists: (sessionId: string, directory: string) => Promise<boolean>;
    // xAI's model catalog (id + humanized label) plus a default id — ALWAYS non-empty, so the picker is never
    // blank and a send always resolves a model. Source, in order: live xAI discovery with the persisted OAuth
    // token (best, when the token is unexpired), else the last-known-good catalog persisted by recordModels, else
    // a compile-time seed floor. Supersedes provider.list() (a static models.dev snapshot whose xai list can be
    // empty and whose default is a retired id xAI rejects). Cached briefly — only real (discovered/recorded)
    // results, never the seed — so a freshened token is retried on the next read.
    readonly xaiModels: () => Promise<{ models: { id: string; label: string }[]; default: string }>;
    // Persist the models xAI itself named as valid (parsed from a "Did you mean: …" rejection during a turn) as
    // the last-known-good catalog. This is the refresh-independent source of truth: it works even when the REST
    // discovery endpoints reject the subscription-OAuth token. Refreshes the cache so the next xaiModels() serves
    // them immediately. No-op for an empty/media-only list.
    readonly recordModels: (ids: string[]) => Promise<void>;
    // Clear a provider's stored auth AND the persisted catalog. No provider-scoped SDK removal exists, so we
    // delete OpenCode's auth store (this instance is Grok-only). ponytail: file-level clear; swap for an SDK call.
    readonly disconnect: (providerID: string) => Promise<void>;
}

// ids → the wire shape ({ models, default }); ids must be non-empty so default is always defined. Neither xAI's
// REST catalog nor its "Did you mean" rejection publishes a ranking (see model-order.ts), so the app imposes the
// order — which is what makes `default` the frontier newest rather than whichever id xAI happened to name first.
const toCatalog = (ids: readonly string[]): { models: { id: string; label: string }[]; default: string } => {
    const ordered = ids.toSorted(compareUnrankedModelIds);
    return { models: ordered.map((id) => ({ id, label: humanizeModelId(id) })), default: ordered[0]! };
};

// How long `opencode serve` gets to print its listening line. The SDK defaults to 5s, which a cold spawn misses
// on a loaded host: the binary is ~175 MB of bun paged in from scratch while boot is also warming the search
// index and starting the watchers (measured: 0.7s idle, 5–10s under that contention). Missing it is expensive —
// the failed warmup pushes the CPU-heavy spawn onto the user's first Grok call, which is exactly what warming at
// boot exists to avoid.
const BOOT_TIMEOUT_MS = 60_000;

export const createOpenCodeService = (xdgDataHome: string, fetchImpl: typeof fetch = fetch): OpenCodeService => {
    let booting: Promise<OpencodeClient> | undefined;
    // xAI's catalog rarely changes, so cache it briefly: a grok turn AND every Claude turn's delegation note read
    // it, and each read is an api.x.ai round-trip. Only a real result (live discovery or recordModels) is cached —
    // the seed/persisted fallbacks stay uncached so a freshened token is retried on the next read. Cleared on
    // disconnect.
    let modelsCache: { value: { models: { id: string; label: string }[]; default: string }; expiresAt: number } | undefined;
    const MODELS_TTL_MS = 60_000;
    const opencodeDir = join(xdgDataHome, "opencode");
    const authPath = join(opencodeDir, "auth.json");
    // The last-known-good catalog, persisted next to auth.json so it survives daemon restarts.
    const modelsPath = join(opencodeDir, "xai-models.json");

    const boot = async (): Promise<OpencodeClient> => {
        // xAI's Responses API stores request/response server-side for 30 days by default (store: true in
        // @ai-sdk/xai) — opt every known model out via per-model options, the only seam OpenCode forwards to the
        // call. Config is fixed at server spawn, so a model first discovered later (the self-heal path) lacks the
        // flag until the next daemon restart; the persisted catalog covers it from then on.
        const storeOptOut = [...new Set([...SEED_XAI_MODELS, ...(await readPersistedModels())])];
        // createOpencodeServer spawns `opencode serve` inheriting process.env (it exposes no env option), so pin
        // XDG_DATA_HOME across the synchronous spawn only — the child captures it at launch; restoring right
        // after keeps the daemon's other subprocess spawns (Claude/Codex) unaffected.
        const previous = process.env["XDG_DATA_HOME"];
        process.env["XDG_DATA_HOME"] = xdgDataHome;
        let server: { url: string; close(): void };
        try {
            server = await createOpencodeServer({
                timeout: BOOT_TIMEOUT_MS,
                // No provider key — xAI auth is OAuth (stored by OpenCode). Run autonomously: the container IS the
                // isolation boundary (same posture as Claude's bypassPermissions / Codex's danger-full-access).
                config: {
                    permission: { edit: "allow", bash: "allow", webfetch: "allow" },
                    provider: { xai: { models: Object.fromEntries(storeOptOut.map((id) => [id, { options: { store: false } }])) } },
                },
            });
        } finally {
            if (previous === undefined) {
                delete process.env["XDG_DATA_HOME"];
            } else {
                process.env["XDG_DATA_HOME"] = previous;
            }
        }
        return createOpencodeClient({ baseUrl: server.url });
    };

    // Single-flight: memoize the in-flight boot, not just the finished client. `opencode serve` takes seconds and
    // binds a fixed port, so a caller arriving mid-spawn (the first Grok connect racing the boot warmup) would
    // start a rival server, and whichever loses the bind fails its caller. Cleared on rejection so a failed boot
    // stays retryable.
    const ensure = (): Promise<OpencodeClient> => {
        booting ??= boot().catch((error: unknown) => {
            booting = undefined;
            throw error;
        });
        return booting;
    };

    // OpenCode's persisted Auth store — each provider keyed at the top level:
    // { xai: { type: "oauth", access, refresh, expires } } (`expires` is a ms epoch). {} when absent/unreadable.
    const readAuth = async (): Promise<Record<string, { type?: string; access?: string; expires?: number } | undefined>> => {
        try {
            return JSON.parse(await readFile(authPath, "utf8")) as Record<string, { type?: string; access?: string; expires?: number } | undefined>;
        } catch {
            return {};
        }
    };
    // The xAI OAuth access token, but only when it's usable for a direct api.x.ai call — i.e. present AND not past
    // its expiry. An expired token would 401 every discovery probe, so we skip discovery and serve the persisted/
    // seed catalog instead; OpenCode refreshes the token on the next turn, after which discovery works again.
    const usableXaiToken = async (): Promise<string | undefined> => {
        const entry = (await readAuth())["xai"];
        if (entry?.type !== "oauth" || typeof entry.access !== "string") {
            return undefined;
        }
        return entry.expires === undefined || Date.now() < entry.expires ? entry.access : undefined;
    };

    // Read the persisted last-known-good catalog (an array of ids). [] when absent/unreadable.
    const readPersistedModels = async (): Promise<string[]> => {
        try {
            const parsed = JSON.parse(await readFile(modelsPath, "utf8")) as unknown;
            return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
        } catch {
            return [];
        }
    };
    const writePersistedModels = async (ids: string[]): Promise<void> => {
        await mkdir(opencodeDir, { recursive: true });
        await writeFile(modelsPath, JSON.stringify(ids));
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
        sessionExists: async (sessionId, directory) => {
            try {
                const client = await ensure();
                return (await client.session.get({ path: { id: sessionId }, query: { directory } })).data !== undefined;
            } catch {
                return false;
            }
        },
        xaiModels: async () => {
            if (modelsCache !== undefined && Date.now() < modelsCache.expiresAt) {
                return modelsCache.value;
            }
            const token = await usableXaiToken();
            if (token !== undefined) {
                const ids = (await discoverXaiModels(token, fetchImpl)).map((model) => model.id);
                if (ids.length > 0) {
                    await writePersistedModels(ids);
                    const value = toCatalog(ids);
                    modelsCache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
                    return value;
                }
            }
            // No live catalog (no token, expired, or discovery came back empty): serve the last-known-good catalog,
            // else the seed floor. Uncached so a usable token is retried next read.
            const persisted = await readPersistedModels();
            return toCatalog(persisted.length > 0 ? persisted : [...SEED_XAI_MODELS]);
        },
        recordModels: async (ids) => {
            const valid = [...new Set(ids.filter(isChatModel))];
            if (valid.length === 0) {
                return;
            }
            await writePersistedModels(valid);
            modelsCache = { value: toCatalog(valid), expiresAt: Date.now() + MODELS_TTL_MS };
        },
        disconnect: async () => {
            modelsCache = undefined;
            await rm(authPath, { force: true });
            await rm(modelsPath, { force: true });
        },
    };
};
