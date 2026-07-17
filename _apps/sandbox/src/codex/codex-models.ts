/* OpenAI/Codex's live model catalog for a native (ChatGPT-account) turn — the source of valid Codex model ids.
 * @openai/codex-sdk exposes NO list-models API and, given no model, the CLI falls back to a built-in default
 * (gpt-5-codex) a ChatGPT account may not accept — the "model is not supported when using Codex with a ChatGPT
 * account" 400. So we resolve the account's real models ourselves and always pass an explicit id.
 *
 * Discovery order (see createCodexCatalog): the bundled translator's OpenAI-compatible /v1/models (it holds the
 * Codex subscription and reports exactly the ids the account can drive) first, then OpenAI's REST /v1/models with
 * the account's OAuth access token, else the persisted last-known-good catalog, else a compile-time seed floor.
 * A model the account rejects mid-turn surfaces `codex-model-invalid`, which reloads this catalog (codex-agent). */

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

// The never-empty floor for the catalog: served only when live discovery yields nothing AND no last-known-good
// catalog was persisted (a fresh, offline, or non-enumerating account). Stable base ids a ChatGPT account can
// drive; if the account actually wants a dated/renamed variant, discovery records the real catalog, so a stale
// seed costs at most one refresh — the picker reloads it. `gpt-5-codex` is intentionally NOT the first entry
// (it's the id that fails on some accounts); the plain chat model is the safer default.
export const SEED_CODEX_MODELS: readonly string[] = ["gpt-5.1", "gpt-5.1-codex"];

const authHeader = (accessToken: string): Record<string, string> => ({ authorization: `Bearer ${accessToken}` });

// A raw OpenAI/Codex model id → a display label matching the other providers' polish (gpt-5-codex → "GPT 5
// Codex"). Uppercases the gpt/o acronyms; title-cases the rest; dotted/dated segments pass through.
export const humanizeModelId = (id: string): string =>
    id
        .split("-")
        .map((token) => (token === "" ? token : /^gpt$/i.test(token) ? "GPT" : token[0]!.toUpperCase() + token.slice(1)))
        .join(" ");

// OpenAI's /v1/models lists every model family (embeddings, audio/tts/whisper, image/dall-e, moderation, …)
// alongside chat models. Keep only the chat/reasoning/codex families a Codex turn can drive (gpt-*, o-series,
// codex-*), excluding the non-chat suffixes — so a future "gpt-5.6-sol" is kept while "gpt-image-1" drops.
export const isCodexModel = (id: string): boolean =>
    /^(gpt-|o\d|codex)/i.test(id) && !/(embedding|whisper|tts|audio|realtime|image|dall-e|moderation|search|transcribe|-instruct|-preview$)/i.test(id);

// GET an OpenAI-compatible model-list endpoint ({ data: [{id}] }); [] on non-ok / parse error, so a caller can
// fall through to the next source. Filtered to chat/codex ids.
const getModelList = async (url: string, accessToken: string, fetchImpl: typeof fetch): Promise<{ id: string; label: string }[]> => {
    const response = await fetchImpl(url, { headers: authHeader(accessToken) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return [];
    }
    const json = (await response.json().catch(() => undefined)) as { data?: { id: string }[] } | undefined;
    return (json?.data ?? [])
        .map((model) => model.id)
        .filter(isCodexModel)
        .map((id) => ({ id, label: humanizeModelId(id) }));
};

// Resolve OpenAI/Codex's model catalog for this account's OAuth access token. Tries OpenAI's REST /v1/models
// (best-effort — a ChatGPT-subscription token doesn't always enumerate there, in which case the caller serves
// the persisted/seed catalog and a turn's self-heal records the real ids). [] when the endpoint names none.
export const discoverCodexModels = async (accessToken: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; label: string }[]> =>
    getModelList(OPENAI_MODELS_URL, accessToken, fetchImpl);

// The translator (CLIProxyAPI) exposes an OpenAI-compatible /v1/models over its Codex subscription credential —
// the authoritative list of ids the account can actually drive. Reads it with the translator's local bearer;
// [] on any failure so discovery falls through to the account token / persisted / seed sources.
export const discoverTranslatorCodexModels = async (
    translatorUrl: string,
    translatorToken: string,
    fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; label: string }[]> => getModelList(`${translatorUrl.replace(/\/$/, "")}/v1/models`, translatorToken, fetchImpl);

// The valid ids OpenAI names when it rejects a model (some errors carry a "Did you mean: a, b" hint, most don't).
// Only the part after "Did you mean" is scanned, so the rejected id itself is never mistaken for a valid one.
export const parseCodexModelSuggestions = (message: string): string[] => {
    const hint = message.split(/did you mean:?/i)[1];
    if (hint === undefined) {
        return [];
    }
    return [...new Set(hint.match(/[a-z0-9][\w.-]+/gi) ?? [])].filter(isCodexModel);
};

// OpenAI surfaces an unusable model as a "not supported"/"model not found" 400 — tag it so the client reloads
// the live catalog and drops the bad pinned model (mirrors Grok's grok-model-invalid self-heal).
export const CODEX_MODEL_INVALID = /model is not supported|model not found|does not exist|no such model|does not have access to|did you mean/i;
