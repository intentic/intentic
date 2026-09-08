// OpenAI/Codex's live model catalog for a ChatGPT-account turn; always resolves an explicit model id, never the CLI's
// built-in default. Discovery order: the translator's /v1/models, then OpenAI's /v1/models with the OAuth token, then
// the persisted catalog, then a compile-time seed.
import { listModels, suggestedModels } from "../../agent/models/model-discovery.js";

const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

// Floor when discovery and the persisted catalog are empty; gpt-5-codex isn't first, it fails on some accounts.
export const SEED_CODEX_MODELS: readonly string[] = ["gpt-5.1", "gpt-5.1-codex"];

// Keeps only chat/reasoning/codex ids (gpt-*, o-series, codex-*), dropping non-chat families and suffixes.
// codex-auto-review is excluded by role: the CLI's own auto-review model, never a user-facing one.
export const isCodexModel = (id: string): boolean =>
    /^(gpt-|o\d|codex)/i.test(id) &&
    !/(embedding|whisper|tts|audio|realtime|image|dall-e|moderation|search|transcribe|auto-review|-instruct|-preview$)/i.test(id);

// owned_by, not the id, tells a Codex row from another subscription (e.g. Antigravity) the translator multiplexes onto
// the same endpoint.
// OpenAI's own endpoint stamps owner openai/openai-internal/system, or omits it; only the translator names another
// vendor.
const isOpenAiOwned = (owner: string | undefined): boolean => owner === undefined || owner === "system" || owner.startsWith("openai");

// OpenAI-owned chat/codex ids from an OpenAI-compatible model-list endpoint; empty on any failure, caller falls through
// to the next source.
const codexModelIds = async (url: string, accessToken: string, fetchImpl: typeof fetch): Promise<string[]> =>
    (await listModels(url, accessToken, fetchImpl)).filter((model) => isOpenAiOwned(model.owner)).map((model) => model.id).filter(isCodexModel);

// OpenAI's REST /v1/models for this account's OAuth token; a ChatGPT-subscription token doesn't always enumerate there,
// so this can return empty.
export const discoverCodexModels = async (accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string[]> =>
    codexModelIds(OPENAI_MODELS_URL, accessToken, fetchImpl);

// Translator's /v1/models over the Codex subscription credential: the authoritative ids this account can drive.
// Empty on any failure; falls through to the account token / persisted / seed sources.
export const discoverTranslatorCodexModels = async (
    translatorUrl: string,
    translatorToken: string,
    fetchImpl: typeof fetch = fetch,
): Promise<string[]> => codexModelIds(`${translatorUrl.replace(/\/$/, "")}/v1/models`, translatorToken, fetchImpl);

// Extracts model ids from OpenAI's rejection-message hint ("Did you mean: a, b"); the token pattern is broad since ids
// share no prefix.
// isCodexModel, not the pattern, filters prose out of the result.
export const parseCodexModelSuggestions = (message: string): string[] => suggestedModels(message, /[a-z0-9][\w.-]+/gi).filter(isCodexModel);

// Non-fatal advisory on the error channel (fallback metadata used); a muted notice, not an error.
export const CODEX_ADVISORY = /defaulting to fallback metadata/i;

// 'model not found' must stay literal: the advisory also pairs those words without rejecting the model.
export const CODEX_MODEL_INVALID = /model is not supported|\bmodel not found\b|does not exist|no such model|does not have access to|did you mean/i;
