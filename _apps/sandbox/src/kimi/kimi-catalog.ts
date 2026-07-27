import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareModelIds } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";
import { type KimiStore, resolveKimiKey } from "./kimi-credentials.js";
import { discoverKimiModels, humanizeModelId, SEED_KIMI_MODELS } from "./kimi-models.js";

/* The Kimi model catalog service — the Kimi twin of codex-catalog.ts. Resolves the ids a Kimi turn can drive,
 * ALWAYS non-empty so the picker is never blank and a turn always resolves a concrete model. Source, in order:
 *   1. Moonshot's OpenAI-compatible /v1/models with a stored key (or the container MOONSHOT_API_KEY);
 *   2. the persisted last-known-good catalog;
 *   3. the compile-time SEED_KIMI_MODELS floor.
 * Cached briefly, and only real (discovered) results are cached — the seed stays uncached so a usable key is
 * retried on the next read (e.g. once the user connects one). */
export interface KimiCatalog {
    // The Kimi models (+ default id), never empty.
    readonly models: () => Promise<{ models: { id: string; label: string }[]; default: string }>;
}

const MODELS_TTL_MS = 60_000;

// Moonshot's OpenAI-compatible /v1/models publishes a SET, not a ranking (see model-order.ts), so the app
// imposes the order — which is what makes `default` the frontier newest rather than whichever id the endpoint
// happened to list first.
const toCatalog = (ids: readonly string[]): { models: { id: string; label: string }[]; default: string } => {
    const ordered = ids.toSorted(compareModelIds);
    return { models: ordered.map((id) => ({ id, label: humanizeModelId(id) })), default: ordered[0]! };
};

export const createKimiCatalog = (store: KimiStore, config: Config, persistPath: string, fetchImpl: typeof fetch = fetch): KimiCatalog => {
    let cache: { value: { models: { id: string; label: string }[]; default: string }; expiresAt: number } | undefined;

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

    return {
        models: async () => {
            if (cache !== undefined && Date.now() < cache.expiresAt) {
                return cache.value;
            }
            const key = await resolveKimiKey(store, config);
            const discovered = key !== undefined ? (await discoverKimiModels(key.apiKey, fetchImpl).catch(() => [])).map((model) => model.id) : [];
            if (discovered.length > 0) {
                await writePersisted(discovered);
                const value = toCatalog(discovered);
                cache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
                return value;
            }
            // No live catalog (no key, or discovery came back empty): serve the last-known-good, else the seed floor.
            const persisted = await readPersisted();
            return toCatalog(persisted.length > 0 ? persisted : [...SEED_KIMI_MODELS]);
        },
    };
};
