import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareModelIds } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";
import { discoverCodexModels, discoverTranslatorCodexModels, humanizeModelId, isCodexModel, SEED_CODEX_MODELS } from "./codex-models.js";

/* The Codex model catalog service — the Codex twin of opencode.ts's xaiModels(). Resolves the ids a Codex turn
 * can actually drive, ALWAYS non-empty so the picker is never blank and a turn always resolves a concrete model
 * (never the SDK's rejected gpt-5-codex default). Source, in order:
 *   1. the bundled translator's OpenAI-compatible /v1/models — it holds the Codex SUBSCRIPTION credential and
 *      reports exactly the subscription's usable ids (the authoritative source once the translator is up);
 *   2. OpenAI's REST /v1/models with the container OPENAI_API_KEY (best-effort dev fallback with no translator);
 *   3. the persisted last-known-good catalog (recorded by a turn's self-heal, refresh-independent);
 *   4. the compile-time SEED_CODEX_MODELS floor.
 * Cached briefly, and only real (discovered/recorded) results are cached — the seed stays uncached so a usable
 * source is retried on the next read. */
export interface CodexCatalog {
    // The Codex models (+ default id), never empty.
    readonly models: () => Promise<{ models: { id: string; label: string }[]; default: string }>;
    // Persist the ids a turn proved valid (self-heal) as the last-known-good catalog, refreshing the cache.
    readonly record: (ids: string[]) => Promise<void>;
}

const MODELS_TTL_MS = 60_000;

// The OpenAI-compatible /v1/models both discovery sources speak publishes a SET, not a ranking (see
// model-order.ts), so the app imposes the order here — on every rung alike, since the persisted list inherits
// whatever order a turn's rejection named its ids in. That is what makes `default` the frontier newest rather
// than whichever id the endpoint happened to list first, and it is the order the picker's groups render in.
const toCatalog = (ids: readonly string[]): { models: { id: string; label: string }[]; default: string } => {
    const ordered = ids.toSorted(compareModelIds);
    return { models: ordered.map((id) => ({ id, label: humanizeModelId(id) })), default: ordered[0]! };
};

export const createCodexCatalog = (config: Config, persistPath: string, fetchImpl: typeof fetch = fetch): CodexCatalog => {
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
            const discovered = (fromTranslator.length > 0 ? fromTranslator : fromOpenAI).map((model) => model.id);
            if (discovered.length > 0) {
                await writePersisted(discovered);
                const value = toCatalog(discovered);
                cache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
                return value;
            }
            // No live catalog: serve the last-known-good, else the seed floor. Uncached so a usable source retries.
            const persisted = await readPersisted();
            return toCatalog(persisted.length > 0 ? persisted : [...SEED_CODEX_MODELS]);
        },
        record: async (ids) => {
            const valid = [...new Set(ids.filter(isCodexModel))];
            if (valid.length === 0) {
                return;
            }
            await writePersisted(valid);
            cache = { value: toCatalog(valid), expiresAt: Date.now() + MODELS_TTL_MS };
        },
    };
};
