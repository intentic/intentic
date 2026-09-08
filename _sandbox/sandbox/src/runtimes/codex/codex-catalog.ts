import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import { idCatalog } from "../../agent/models/model-discovery.js";
import type { Config } from "../../env.config.js";
import { jsonFile } from "../../store/json-file.js";
import { discoverCodexModels, discoverTranslatorCodexModels, isCodexModel, SEED_CODEX_MODELS } from "./codex-models.js";

// Codex model catalog on the shared ladder (agent/model-catalog.ts): live, then persisted last-known-good, then the
// SEED_CODEX_MODELS floor. Live source, in order:
// 1. the translator's OpenAI-compatible /v1/models (the subscription's authoritative list)
// 2. OpenAI's REST /v1/models with the container OPENAI_API_KEY (dev fallback)
export interface CodexCatalog {
    // The Codex models (+ default id), never empty.
    readonly models: () => Promise<{ models: { id: string; label: string }[]; default: string }>;
    // Persists the ids a turn proved valid (self-heal) as the last-known-good catalog, refreshing the cache.
    readonly record: (ids: string[]) => Promise<void>;
}

const MODELS_TTL_MS = 60_000;

export const createCodexCatalog = (config: Config, persistPath: string, fetchImpl: typeof fetch = fetch): CodexCatalog => {
    const catalog = discoveredCatalog({
        ttlMs: MODELS_TTL_MS,
        discover: async () => {
            // The translator holds the Codex subscription, so its /v1/models is the subscription's real usable list.
            const fromTranslator =
                config.translator.url !== ""
                    ? await discoverTranslatorCodexModels(config.translator.url, config.translator.token, fetchImpl).catch(() => [])
                    : [];
            // Dev fallback with no translator: the container OPENAI_API_KEY can enumerate OpenAI's REST /v1/models.
            const fromOpenAI =
                fromTranslator.length === 0 && config.openaiApiKey !== ""
                    ? await discoverCodexModels(config.openaiApiKey, fetchImpl).catch(() => [])
                    : [];
            return fromTranslator.length > 0 ? fromTranslator : fromOpenAI;
        },
        store: jsonFile<string[]>(persistPath, {
            parse: (raw) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : undefined),
            fallback: () => [],
        }),
        toStored: (ids) => [...ids],
        seed: SEED_CODEX_MODELS,
        fromLive: idCatalog,
        fromStored: idCatalog,
    });
    return {
        models: catalog.models,
        record: async (ids) => {
            const valid = [...new Set(ids.filter(isCodexModel))];
            if (valid.length === 0) {
                return;
            }
            await catalog.record(valid);
        },
    };
};
