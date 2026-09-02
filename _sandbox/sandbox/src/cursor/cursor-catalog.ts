import type { ModelListItem } from "@cursor/sdk";
import type { Model } from "@intentic/sandbox-contract";
import { discoveredCatalog } from "../agent/model-catalog.js";
import { jsonFile } from "../store/json-file.js";
import type { CursorStore } from "./cursor-credentials.js";
import { SEED_CURSOR_MODELS, seedCatalog, toCatalog } from "./cursor-models.js";
import { cursorSdk } from "./cursor-sdk.js";

/* THE CURSOR MODEL CATALOG SERVICE, on the shared ladder (agent/model-catalog.ts). Answers "what can a Cursor
 * turn run", ALWAYS non-empty, which matters more here than anywhere else in this repo, because the SDK REQUIRES
 * a model for a local agent and has no default of its own to fall back to. The live source is
 * `Cursor.models.list()` with a connected account's key, which is the account's real entitlement, not a general
 * list: two accounts on different plans genuinely see different rows. The floor is the one id `auto`.
 *
 * THE RAW ITEMS ARE KEPT, not just the mapped rows (the ladder's `live`). A turn needs more than an id: it needs
 * the model's parameter definitions to translate an effort tier into the `params` Cursor accepts
 * (cursor-models.ts). Re-fetching the list per turn to recover them would put a network round-trip on the turn
 * path for something already in memory. */
export interface CursorCatalog {
    // The models (+ default id), never empty.
    readonly models: () => Promise<{ models: Model[]; default: string }>;
    /* The vendor's own record for one id, when the live list is what is currently in hand. Undefined for a
     * seeded or persisted rung, which carries ids and nothing else: the caller then sends the bare id, which
     * is exactly right, an effort tier we cannot translate is one we must not guess at. */
    readonly item: (id: string) => Promise<ModelListItem | undefined>;
}

const MODELS_TTL_MS = 60_000;

export const createCursorCatalog = (store: CursorStore, persistPath: string): CursorCatalog => {
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

    const catalog = discoveredCatalog({
        ttlMs: MODELS_TTL_MS,
        discover,
        store: jsonFile<string[]>(persistPath, {
            parse: (raw) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : undefined),
            fallback: () => [],
        }),
        toStored: (items) => items.map((item) => item.id),
        seed: SEED_CURSOR_MODELS,
        fromLive: toCatalog,
        fromStored: seedCatalog,
    });
    return {
        models: catalog.models,
        item: async (id) => (await catalog.live())?.find((item) => item.id === id),
    };
};
