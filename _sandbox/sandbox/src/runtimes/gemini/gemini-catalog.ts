import { compareUnrankedModelIds } from "@intentic/sandbox-contract";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import type { Config } from "../../env.config.js";
import { jsonFile } from "../../store/json-file.js";
import { discoverGeminiModels, type GeminiModel, SEED_GEMINI_MODELS } from "./gemini-models.js";

// Google-channel model catalog on the shared ladder; account-only, no API-key fallback, so the SEED_GEMINI_MODELS floor
// shows until the translator's account connects. Labels and input modalities are persisted alongside ids, never
// re-derived; a persisted entry missing modalities reads as absent, not text-only, until the next discovery rewrites
// it.
export interface GeminiCatalog {
    // Google-channel models plus the default id, never empty.
    readonly models: () => Promise<{ models: GeminiModel[]; default: string }>;
}

const MODELS_TTL_MS = 60_000;

// The translator's endpoints publish an unranked set (model-order.ts imposes order), so this keeps Pro above Flash and
// makes default the newest frontier id, not whichever the endpoint listed first.
const toCatalog = (models: readonly GeminiModel[]): { models: GeminiModel[]; default: string } => {
    const ordered = models.toSorted((left, right) => compareUnrankedModelIds(left.id, right.id));
    return { models: [...ordered], default: ordered[0]!.id };
};

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
        store: jsonFile<GeminiModel[]>(persistPath, {
            parse: (raw) => (Array.isArray(raw) ? raw.filter(isGeminiModel) : undefined),
            fallback: () => [],
        }),
        toStored: (models) => [...models],
        seed: SEED_GEMINI_MODELS,
        fromLive: toCatalog,
        fromStored: toCatalog,
    });
    return { models: catalog.models };
};
