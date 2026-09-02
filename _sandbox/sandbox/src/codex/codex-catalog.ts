import { compareUnrankedModelIds } from "@intentic/sandbox-contract";
import { discoveredCatalog } from "../agent/model-catalog.js";
import type { Config } from "../env.config.js";
import { jsonFile } from "../store/json-file.js";
import { discoverCodexModels, discoverTranslatorCodexModels, humanizeModelId, isCodexModel, SEED_CODEX_MODELS } from "./codex-models.js";

/* The Codex model catalog service, on the shared ladder (agent/model-catalog.ts): live, then the persisted
 * last-known-good (recorded by a turn's self-heal, refresh-independent), then the SEED_CODEX_MODELS floor, so
 * a turn always resolves a concrete model (never the CLI's rejected gpt-5-codex fallback). The live source is
 *   1. the bundled translator's OpenAI-compatible /v1/models, it holds the Codex SUBSCRIPTION credential and
 *      reports exactly the subscription's usable ids (the authoritative source once the translator is up);
 *   2. OpenAI's REST /v1/models with the container OPENAI_API_KEY (best-effort dev fallback with no translator). */
export interface CodexCatalog {
    // The Codex models (+ default id), never empty.
    readonly models: () => Promise<{ models: { id: string; label: string }[]; default: string }>;
    // Persist the ids a turn proved valid (self-heal) as the last-known-good catalog, refreshing the cache.
    readonly record: (ids: string[]) => Promise<void>;
}

const MODELS_TTL_MS = 60_000;

// The OpenAI-compatible /v1/models both discovery sources speak publishes a SET, not a ranking (see
// model-order.ts), so the app imposes the order here, on every rung alike, since the persisted list inherits
// whatever order a turn's rejection named its ids in. That is what makes `default` the frontier newest rather
// than whichever id the endpoint happened to list first, and it is the order the picker's groups render in.
// Unranked, so same-tier same-release siblings (the gpt-5.6-* line) break their tie on the id: the translator
// reorders its rows between requests, and this catalog's head is the model a fresh conversation opens on.
const toCatalog = (ids: readonly string[]): { models: { id: string; label: string }[]; default: string } => {
    const ordered = ids.toSorted(compareUnrankedModelIds);
    return { models: ordered.map((id) => ({ id, label: humanizeModelId(id) })), default: ordered[0]! };
};

export const createCodexCatalog = (config: Config, persistPath: string, fetchImpl: typeof fetch = fetch): CodexCatalog => {
    const catalog = discoveredCatalog({
        ttlMs: MODELS_TTL_MS,
        discover: async () => {
            // The translator holds the Codex subscription, so its /v1/models is the subscription's real usable list.
            const fromTranslator =
                config.translator.url !== ""
                    ? await discoverTranslatorCodexModels(config.translator.url, config.translator.token, fetchImpl).catch(() => [])
                    : [];
            // Dev fallback (no translator): the container OPENAI_API_KEY can enumerate OpenAI's REST /v1/models.
            const fromOpenAI =
                fromTranslator.length === 0 && config.openaiApiKey !== ""
                    ? await discoverCodexModels(config.openaiApiKey, fetchImpl).catch(() => [])
                    : [];
            return (fromTranslator.length > 0 ? fromTranslator : fromOpenAI).map((model) => model.id);
        },
        store: jsonFile<string[]>(persistPath, {
            parse: (raw) => (Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : undefined),
            fallback: () => [],
        }),
        toStored: (ids) => [...ids],
        seed: SEED_CODEX_MODELS,
        fromLive: toCatalog,
        fromStored: toCatalog,
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
