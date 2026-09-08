import type { ModelListItem } from "@cursor/sdk";
import type { Model } from "@intentic/sandbox-contract";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import { jsonFile } from "../../store/json-file.js";
import type { CursorStore } from "./cursor-credentials.js";
import { SEED_CURSOR_MODELS, seedCatalog, toCatalog } from "./cursor-models.js";
import { cursorSdk } from "./cursor-sdk.js";

// Cursor's model catalog on the shared ladder; always non-empty since the SDK requires a model with no default. Live
// source is Cursor.models.list() with a connected account's key (real entitlement, accounts can differ); floor is
// "auto". Keeps raw items, not just mapped rows, so effort-tier translation (cursor-models.ts) needs no per-turn round
// trip.
export interface CursorCatalog {
    // Never empty; models plus the default id.
    readonly models: () => Promise<{ models: Model[]; default: string }>;
    // Vendor record for one id from the live list; undefined for a seeded/persisted rung, so the bare id is sent.
    readonly item: (id: string) => Promise<ModelListItem | undefined>;
}

const MODELS_TTL_MS = 60_000;

export const createCursorCatalog = (store: CursorStore, persistPath: string): CursorCatalog => {
    // Uses the first usable account, not all: accounts can see different lists (plan, policy), and a union would
    // promise models the other can't run. The first connected account is also the one an unrouted turn spends.
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
        idOf: (item) => item.id,
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
