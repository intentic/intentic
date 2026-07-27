import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareModelIds } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";
import { discoverGeminiModels, humanizeModelId, SEED_GEMINI_MODELS } from "./gemini-models.js";

/* The Gemini model catalog service — the Gemini twin of codex-catalog.ts. Resolves the ids a Gemini turn can
 * drive, ALWAYS non-empty so the picker is never blank and a turn always resolves a concrete model. Source, in
 * order:
 *   1. the bundled translator's OpenAI-compatible /v1/models — it holds the Google account and reports exactly
 *      the ids that account can drive (the authoritative source once a Google account is connected);
 *   2. the persisted last-known-good catalog;
 *   3. the compile-time SEED_GEMINI_MODELS floor.
 * Unlike Codex there is no API-key fallback source: Gemini is subscription-only here, so with no translator
 * (a bare `tsx watch` dev run) the seed floor is what the picker shows and a turn surfaces the routed-provider
 * error. Cached briefly, and only real (discovered) results are cached — the seed stays uncached so a usable
 * source is retried on the next read (e.g. once the user connects their Google account). */
export interface GeminiCatalog {
    // The Gemini models (+ default id), never empty.
    readonly models: () => Promise<{ models: { id: string; label: string }[]; default: string }>;
}

const MODELS_TTL_MS = 60_000;

// The translator's OpenAI-compatible /v1/models publishes a SET, not a ranking (see model-order.ts), so the app
// imposes the order — which is what keeps Pro above Flash in the picker and makes `default` the frontier newest
// rather than whichever id the endpoint happened to list first.
const toCatalog = (ids: readonly string[]): { models: { id: string; label: string }[]; default: string } => {
    const ordered = ids.toSorted(compareModelIds);
    return { models: ordered.map((id) => ({ id, label: humanizeModelId(id) })), default: ordered[0]! };
};

export const createGeminiCatalog = (config: Config, persistPath: string, fetchImpl: typeof fetch = fetch): GeminiCatalog => {
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
            const discovered =
                config.translator.url !== ""
                    ? (await discoverGeminiModels(config.translator.url, config.translator.token, fetchImpl).catch(() => [])).map((model) => model.id)
                    : [];
            if (discovered.length > 0) {
                await writePersisted(discovered);
                const value = toCatalog(discovered);
                cache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
                return value;
            }
            // No live catalog (no Google account, or no translator): serve the last-known-good, else the seed floor.
            const persisted = await readPersisted();
            return toCatalog(persisted.length > 0 ? persisted : [...SEED_GEMINI_MODELS]);
        },
    };
};
