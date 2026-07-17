import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Config } from "../env.config.js";
import type { CodexStore } from "./codex-credentials.js";
import { discoverCodexModels, discoverTranslatorCodexModels, humanizeModelId, isCodexModel, SEED_CODEX_MODELS } from "./codex-models.js";

/* The Codex model catalog service — the Codex twin of opencode.ts's xaiModels(). Resolves the ids a native
 * (ChatGPT-account) Codex turn can actually drive, ALWAYS non-empty so the picker is never blank and a turn always
 * resolves a concrete model (never the SDK's rejected gpt-5-codex default). Source, in order:
 *   1. the bundled translator's OpenAI-compatible /v1/models — it holds the Codex SUBSCRIPTION credential and
 *      reports exactly the account's usable ids (the authoritative source once the translator is up);
 *   2. OpenAI's REST /v1/models with the account's OAuth access token (best-effort — a ChatGPT-subscription token
 *      usually can't enumerate there, so this is a fallback for API-key accounts);
 *   3. the persisted last-known-good catalog (recorded by a turn's self-heal, refresh-independent);
 *   4. the compile-time SEED_CODEX_MODELS floor.
 * Cached briefly, and only real (discovered/recorded) results are cached — the seed stays uncached so a usable
 * source is retried on the next read. */
export interface CodexCatalog {
    // The account's Codex models (+ default id). accountId picks whose token feeds OpenAI discovery; omitted ⇒ the
    // first connected account (else the OPENAI_API_KEY fallback). Never empty.
    readonly models: (accountId?: string) => Promise<{ models: { id: string; label: string }[]; default: string }>;
    // Persist the ids a turn proved valid (self-heal) as the last-known-good catalog, refreshing the cache.
    readonly record: (ids: string[]) => Promise<void>;
}

const MODELS_TTL_MS = 60_000;

export const createCodexCatalog = (codexStore: CodexStore, config: Config, persistPath: string, fetchImpl: typeof fetch = fetch): CodexCatalog => {
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

    const toCatalog = (ids: string[]): { models: { id: string; label: string }[]; default: string } => ({
        models: ids.map((id) => ({ id, label: humanizeModelId(id) })),
        default: ids[0]!,
    });

    // The token OpenAI discovery uses: the selected/first account's OAuth access token, else the container OpenAI
    // API key fallback. undefined ⇒ no account discovery is possible (the translator path may still work).
    const accountToken = async (accountId?: string): Promise<string | undefined> => {
        const id = accountId ?? (await codexStore.list())[0]?.id;
        const tokens = id !== undefined ? await codexStore.read(id) : undefined;
        return tokens?.accessToken ?? (config.openaiApiKey !== "" ? config.openaiApiKey : undefined);
    };

    return {
        models: async (accountId) => {
            if (cache !== undefined && Date.now() < cache.expiresAt) {
                return cache.value;
            }
            // The translator holds the Codex subscription, so its /v1/models is the account's real usable list.
            const fromTranslator =
                config.translator.url !== ""
                    ? await discoverTranslatorCodexModels(config.translator.url, config.translator.token, fetchImpl).catch(() => [])
                    : [];
            const token = await accountToken(accountId);
            const fromOpenAI = fromTranslator.length === 0 && token !== undefined ? await discoverCodexModels(token, fetchImpl).catch(() => []) : [];
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
