import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import { unrankedCatalog } from "../../agent/models/model-discovery.js";
import type { Config } from "../../env.config.js";
import { cacheFile } from "../../store/open-document.js";
import { discoverGeminiModels, type GeminiModel, SEED_GEMINI_MODELS } from "./gemini-models.js";

// Google-channel model catalog on the shared ladder; account-only, no API-key fallback, so the SEED_GEMINI_MODELS floor
// Persist model metadata and treat missing modalities as undiscovered.
export interface GeminiCatalog {
    // Google-channel models plus the default id, never empty.
    readonly models: () => Promise<{ models: GeminiModel[]; default: string }>;
    // What the translator serves; undefined when it has never listed a Google model, whatever `models` falls back to.
    readonly live: () => Promise<readonly GeminiModel[] | undefined>;
}

const MODELS_TTL_MS = 60_000;

const isGeminiModel = (entry: unknown): entry is GeminiModel => {
    const model = entry as { id?: unknown; label?: unknown; inputModalities?: unknown };
    return (
        typeof model.id === "string" &&
        typeof model.label === "string" &&
        Array.isArray(model.inputModalities) &&
        model.inputModalities.every((modality) => typeof modality === "string")
    );
};

export const createGeminiCatalog = (config: Config, persistPath: string, fetchImpl: typeof fetch = fetch): GeminiCatalog => {
    const catalog = discoveredCatalog({
        ttlMs: MODELS_TTL_MS,
        discover: () =>
            config.translator.url !== ""
                ? discoverGeminiModels(config.translator.url, config.translator.token, fetchImpl).catch((): GeminiModel[] => [])
                : Promise.resolve<GeminiModel[]>([]),
        idOf: (model) => model.id,
        store: cacheFile<GeminiModel[]>(persistPath, {
            parse: (raw) => (Array.isArray(raw) ? raw.filter(isGeminiModel) : undefined),
            fallback: () => [],
        }),
        toStored: (models) => [...models],
        seed: SEED_GEMINI_MODELS,
        // The translator publishes an unranked set: Pro above Flash, and the newest frontier id the default, not its first.
        fromLive: unrankedCatalog,
        fromStored: unrankedCatalog,
    });
    return { models: catalog.models, live: catalog.live };
};
