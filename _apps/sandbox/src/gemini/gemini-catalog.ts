import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { compareModelIds } from "@intentic/sandbox-contract";
import type { Config } from "../env.config.js";
import { discoverGeminiModels, SEED_GEMINI_MODELS } from "./gemini-models.js";

/* The Google-channel model catalog service — the twin of codex-catalog.ts. Resolves the ids a turn on this
 * provider can drive, ALWAYS non-empty so the picker is never blank and a turn always resolves a concrete model.
 * Source, in order:
 *   1. the bundled translator's model endpoints — it holds the Google account and reports exactly the ids that
 *      account can drive (the authoritative source once a Google account is connected);
 *   2. the persisted last-known-good catalog;
 *   3. the compile-time SEED_GEMINI_MODELS floor.
 * There is no API-key fallback source: this channel is account-only, so with no translator (a bare `tsx watch`
 * dev run) the seed floor is what the picker shows and a turn surfaces the routed-provider error. Cached briefly,
 * and only real (discovered) results are cached — the seed stays uncached so a usable source is retried on the
 * next read (e.g. once the user connects their Google account).
 *
 * Labels are PERSISTED alongside the ids rather than re-derived, because the translator publishes real display
 * names ("Gemini 3.1 Pro (High)") that no rule can recover from the id. */
export interface GeminiCatalog {
    // The Google-channel models (+ default id), never empty.
    readonly models: () => Promise<{ models: { id: string; label: string }[]; default: string }>;
}

const MODELS_TTL_MS = 60_000;

// The translator's model endpoints publish a SET, not a ranking (see model-order.ts), so the app imposes the
// order — which is what keeps Pro above Flash in the picker and makes `default` the frontier newest rather than
// whichever id the endpoint happened to list first.
const toCatalog = (models: readonly { id: string; label: string }[]): { models: { id: string; label: string }[]; default: string } => {
    const ordered = models.toSorted((left, right) => compareModelIds(left.id, right.id));
    return { models: [...ordered], default: ordered[0]!.id };
};

export const createGeminiCatalog = (config: Config, persistPath: string, fetchImpl: typeof fetch = fetch): GeminiCatalog => {
    let cache: { value: { models: { id: string; label: string }[]; default: string }; expiresAt: number } | undefined;

    const readPersisted = async (): Promise<{ id: string; label: string }[]> => {
        try {
            const parsed = JSON.parse(await readFile(persistPath, "utf8")) as unknown;
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed.filter((entry): entry is { id: string; label: string } => {
                const model = entry as { id?: unknown; label?: unknown };
                return typeof model.id === "string" && typeof model.label === "string";
            });
        } catch {
            return [];
        }
    };
    const writePersisted = async (models: { id: string; label: string }[]): Promise<void> => {
        await mkdir(dirname(persistPath), { recursive: true });
        await writeFile(persistPath, JSON.stringify(models));
    };

    return {
        models: async () => {
            if (cache !== undefined && Date.now() < cache.expiresAt) {
                return cache.value;
            }
            const discovered =
                config.translator.url !== ""
                    ? await discoverGeminiModels(config.translator.url, config.translator.token, fetchImpl).catch(() => [])
                    : [];
            if (discovered.length > 0) {
                await writePersisted(discovered);
                const value = toCatalog(discovered);
                cache = { value, expiresAt: Date.now() + MODELS_TTL_MS };
                return value;
            }
            // No live catalog (no Google account, or no translator): serve the last-known-good, else the seed floor.
            const persisted = await readPersisted();
            return toCatalog(persisted.length > 0 ? persisted : SEED_GEMINI_MODELS);
        },
    };
};
