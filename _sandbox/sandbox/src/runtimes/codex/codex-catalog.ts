import { join } from "node:path";
import { compareUnrankedModelIds, humanizeModelId, type Model, ModelSchema } from "@intentic/sandbox-contract";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import type { Config } from "../../env.config.js";
import { jsonFile } from "../../store/json-file.js";
import { codexModelList, type CodexModelListReader } from "./codex-model-list.js";
import { discoverCodexModels, discoverTranslatorCodexModels, isCodexModel, SEED_CODEX_MODELS } from "./codex-models.js";

// Codex model catalog on the shared ladder (agent/model-catalog.ts): live, then persisted last-known-good, then the
// SEED_CODEX_MODELS floor. Live source, in order:
// 1. the translator's OpenAI-compatible /v1/models (the subscription's authoritative list)
// 2. OpenAI's REST /v1/models with the container OPENAI_API_KEY (dev fallback)
// Either answers ids alone, so the CLI's own model/list runs alongside them for what an id cannot say: display name,
// description, and the reasoning rungs the model accepts. With no id source configured, model/list is the catalog.
export interface CodexCatalog {
    // The Codex models (+ default id), never empty.
    readonly models: () => Promise<{ models: Model[]; default: string }>;
    // Persists the ids a turn proved valid (self-heal) as the last-known-good catalog, refreshing the cache.
    readonly record: (ids: string[]) => Promise<void>;
}

const MODELS_TTL_MS = 60_000;

// Where the last-known-good catalog lives inside CODEX_HOME.
const persistPathOf = (codexHome: string): string => join(codexHome, "models.json");

// Head of the list is what a fresh conversation opens on, so the two are never decided separately.
const catalogOf = (models: readonly Model[]): { models: Model[]; default: string } => ({ models: [...models], default: models[0]!.id });

export const createCodexCatalog = (
    config: Config,
    codexHome: string,
    injected: { readonly fetchImpl?: typeof fetch; readonly listModels?: CodexModelListReader } = {},
): CodexCatalog => {
    const fetchImpl = injected.fetchImpl ?? fetch;
    const listModels = injected.listModels ?? codexModelList(codexHome);
    // What the runtime last published about each id, so a turn's self-heal and an id-only discovery both render a model
    // with its own scale rather than stripping it back to a label.
    const published = new Map<string, Model>();
    const modelFor = (id: string): Model => published.get(id) ?? { id, label: humanizeModelId(id) };
    // An unordered set of ids is the app's to rank (model-order.ts); model/list arrives in Codex's own order and keeps
    // it.
    const ranked = (ids: readonly string[]): Model[] => ids.toSorted(compareUnrankedModelIds).map(modelFor);

    const discoverIds = async (): Promise<readonly string[]> => {
        // The translator holds the Codex subscription, so its /v1/models is the subscription's real usable list.
        const fromTranslator =
            config.translator.url !== ""
                ? await discoverTranslatorCodexModels(config.translator.url, config.translator.token, fetchImpl).catch(() => [])
                : [];
        if (fromTranslator.length > 0) {
            return fromTranslator;
        }
        // Dev fallback with no translator: the container OPENAI_API_KEY can enumerate OpenAI's REST /v1/models.
        return config.openaiApiKey !== "" ? await discoverCodexModels(config.openaiApiKey, fetchImpl).catch(() => []) : [];
    };

    const catalog = discoveredCatalog<Model, Model, { models: Model[]; default: string }, []>({
        ttlMs: MODELS_TTL_MS,
        // Both sources run together: neither waits on the other, and the ids decide the catalog while the metadata only
        // dresses it.
        discover: async () => {
            const [metadata, ids] = await Promise.all([listModels(), discoverIds()]);
            for (const model of metadata) {
                published.set(model.id, model);
            }
            return ids.length > 0 ? ranked(ids) : metadata;
        },
        idOf: (model) => model.id,
        store: jsonFile<Model[]>(persistPathOf(codexHome), {
            parse: (raw) => {
                const stored = ModelSchema.array().safeParse(raw);
                return stored.success ? stored.data : undefined;
            },
            fallback: () => [],
        }),
        toStored: (models) => [...models],
        // The floor is compile-time, so it carries no scale: an id and a label is all it can honestly claim.
        seed: SEED_CODEX_MODELS.map((id) => ({ id, label: humanizeModelId(id) })),
        fromLive: catalogOf,
        fromStored: catalogOf,
    });
    return {
        models: catalog.models,
        record: async (ids) => {
            const valid = [...new Set(ids.filter(isCodexModel))];
            if (valid.length === 0) {
                return;
            }
            await catalog.record(ranked(valid));
        },
    };
};
