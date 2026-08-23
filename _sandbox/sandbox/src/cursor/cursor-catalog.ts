import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { ModelListItem } from "@cursor/sdk";
import type { Model } from "@intentic/sandbox-contract";
import type { CursorStore } from "./cursor-credentials.js";
import { SEED_CURSOR_MODELS, seedCatalog, toCatalog } from "./cursor-models.js";
import { cursorSdk } from "./cursor-sdk.js";

/* THE CURSOR MODEL CATALOG SERVICE, the Cursor twin of codex-catalog.ts and opencode.ts's xaiModels(). Answers
 * "what can a Cursor turn run", ALWAYS non-empty, so the picker is never blank and a turn always resolves a
 * concrete model — which matters more here than anywhere else in this repo, because the SDK REQUIRES a model
 * for a local agent and has no default of its own to fall back to.
 *
 * The ladder, in order:
 *   1. `Cursor.models.list()` with a connected account's key, which is the account's real entitlement, not a
 *      general list: two accounts on different plans genuinely see different rows;
 *   2. the persisted last-known-good list, written by every successful discovery;
 *   3. the one-id seed floor (`auto`).
 *
 * Cached briefly, and ONLY the real answers are cached. A seeded read stays uncached so the very next call
 * retries a source that may since have become available, which is the difference between a sandbox that
 * recovers on its own a second after sign-in and one that shows a single row for a minute.
 *
 * THE RAW ITEMS ARE KEPT, not just the mapped rows, and that is the one way this differs in shape from its
 * siblings. A turn needs more than an id: it needs the model's parameter definitions to translate an effort
 * tier into the `params` Cursor accepts (cursor-models.ts). Re-fetching the list per turn to recover them would
 * put a network round-trip on the turn path for something already in memory. */
export interface CursorCatalog {
    // The models (+ default id), never empty.
    readonly models: () => Promise<{ models: Model[]; default: string }>;
    /* The vendor's own record for one id, when the live list is what is currently in hand. Undefined for a
     * seeded or persisted rung, which carries ids and nothing else: the caller then sends the bare id, which
     * is exactly right, an effort tier we cannot translate is one we must not guess at. */
    readonly item: (id: string) => Promise<ModelListItem | undefined>;
}

const MODELS_TTL_MS = 60_000;

interface Cached {
    readonly items: readonly ModelListItem[];
    readonly value: { models: Model[]; default: string };
    readonly expiresAt: number;
}

export const createCursorCatalog = (store: CursorStore, persistPath: string): CursorCatalog => {
    let cache: Cached | undefined;

    const readPersisted = async (): Promise<string[]> => {
        try {
            const parsed = JSON.parse(await readFile(persistPath, "utf8")) as unknown;
            return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
        } catch {
            return [];
        }
    };
    const writePersisted = async (ids: string[]): Promise<void> => {
        await mkdir(dirname(persistPath), { recursive: true });
        await writeFile(persistPath, JSON.stringify(ids));
    };

    /* Ask Cursor, through the FIRST usable account rather than through all of them.
     *
     * Two accounts can genuinely see different lists (different plans, different team policy), so a union
     * would offer rows that only one of them can actually run and a turn picking the other would fail on a
     * model the picker had promised. One account's answer is at least internally consistent, and the first
     * connected one is the same account a turn with no explicit choice will spend. */
    const discover = async (): Promise<ModelListItem[]> => {
        const sdk = await cursorSdk();
        if (sdk === undefined) {
            return [];
        }
        const accounts = await store.credentials();
        const account = accounts.find((entry) => entry.apiKeyExpiresAtMs === undefined || entry.apiKeyExpiresAtMs > Date.now());
        if (account === undefined) {
            return [];
        }
        return sdk.Cursor.models.list({ apiKey: account.apiKey }).catch((error: unknown) => {
            store.logger.warn({ err: error }, "cursor: model discovery failed, serving the last-known-good list");
            return [];
        });
    };

    return {
        models: async () => {
            if (cache !== undefined && Date.now() < cache.expiresAt) {
                return cache.value;
            }
            const items = await discover();
            if (items.length > 0) {
                await writePersisted(items.map((item) => item.id));
                const value = toCatalog(items);
                cache = { items, value, expiresAt: Date.now() + MODELS_TTL_MS };
                return value;
            }
            // No live catalog: the last-known-good ids, else the floor. Uncached, so a usable source is retried.
            const persisted = await readPersisted();
            return seedCatalog(persisted.length > 0 ? persisted : SEED_CURSOR_MODELS);
        },
        item: async (id) => {
            if (cache === undefined || Date.now() >= cache.expiresAt) {
                // Warm it through the same path a picker would, so the two can never disagree about what is
                // current, then read the items that load produced.
                await (async () => {
                    const items = await discover();
                    if (items.length > 0) {
                        await writePersisted(items.map((entry) => entry.id));
                        cache = { items, value: toCatalog(items), expiresAt: Date.now() + MODELS_TTL_MS };
                    }
                })();
            }
            return cache?.items.find((item) => item.id === id);
        },
    };
};
