import { compareUnrankedModelIds } from "@intentic/sandbox-contract";
import { discoveredCatalog } from "../agent/model-catalog.js";
import type { Config } from "../env.config.js";
import { jsonFile } from "../store/json-file.js";
import { discoverGeminiModels, type GeminiModel, SEED_GEMINI_MODELS } from "./gemini-models.js";

/* The Google-channel model catalog service, on the shared ladder (agent/model-catalog.ts). The live source is
 * the bundled translator's model endpoints: it holds the Google account and reports exactly the ids that
 * account can drive. There is no API-key fallback source: this channel is account-only, so with no translator
 * (a bare `tsx watch` dev run) the SEED_GEMINI_MODELS floor is what the picker shows and a turn surfaces the
 * routed-provider error, until the next read finds the account connected.
 *
 * Labels and input modalities are PERSISTED alongside the ids rather than re-derived, because the translator
 * publishes both ("Gemini 3.1 Pro (High)", text+image) and no rule can recover either from the id. A persisted
 * entry must carry the modalities too, so a file written before they were discovered reads as nothing rather
 * than as a fleet of text-only models: absent sends the caller to the seed floor, which declares them
 * truthfully, and the next discovery rewrites the file. */
export interface GeminiCatalog {
    // The Google-channel models (+ default id), never empty.
    readonly models: () => Promise<{ models: GeminiModel[]; default: string }>;
}

const MODELS_TTL_MS = 60_000;

// The translator's model endpoints publish a SET, not a ranking (see model-order.ts), so the app imposes the
// order, which is what keeps Pro above Flash in the picker and makes `default` the frontier newest rather than
// whichever id the endpoint happened to list first.
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
