// OpenAI/Codex's live model catalog for a ChatGPT-account turn; always resolves an explicit model id, never the CLI's
// built-in default. Discovery order: the translator's /v1/models, then OpenAI's /v1/models with the OAuth token, then
// the persisted catalog, then a compile-time seed.
import { escapeRegExp } from "@intentic/base/escape";
import { listModels } from "../../agent/models/model-discovery.js";
import { isModelRefusalText } from "../../engines/failure-sentences.js";

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

// The Codex CLI's own words for the notices this runtime reads, as against an upstream API's text it relays: each must
// stay in the installed binary (agent/providers/tests/vendor-phrases.integration.test.ts), so a release that rewords
// one fails a suite instead of reaching the chat as the notice it came as.
const FALLBACK_METADATA = "Defaulting to fallback metadata";
const RESUMING_WITH = "but is resuming with";
// The in-turn retry notice ("Reconnecting... 2/5 (...)") and the heads-up after an auto-compaction (codex-agent.ts).
export const CODEX_RECONNECTING = "Reconnecting...";
export const CODEX_COMPACTION_NOTICE = "Long threads and multiple compactions";
export const CODEX_CLI_PHRASES: readonly string[] = [CODEX_RECONNECTING, CODEX_COMPACTION_NOTICE, FALLBACK_METADATA, RESUMING_WITH];

// Non-fatal advisory on the error channel (fallback metadata used); a muted notice, not an error.
export const CODEX_ADVISORY = new RegExp(escapeRegExp(FALLBACK_METADATA), "i");

// Codex's resume warning when the thread's last recorded model isn't the one now picked. Dropped rather than shown:
// switching model mid-conversation is a first-class move here, the chat already prints its own "Switched to ..." line,
// and Codex's advice to switch back argues with a deliberate pick.
export const CODEX_MODEL_RESUMED_ELSEWHERE = new RegExp(`recorded with model.+${escapeRegExp(RESUMING_WITH)}`, "is");

// Codex's ChatGPT-account refusal ("The 'gpt-5-codex' model is not supported when using Codex with a ChatGPT account."),
// beside every vendor's (isModelRefusalText, where 'model not found' stays literal: the advisory above also pairs those
// words without rejecting the model).
// allow(dependency-text): the Codex CLI and OpenAI's API; an unmatched wording stays an uncoded failure, the pin kept.
const CODEX_MODEL_UNSUPPORTED = /\bmodel is not supported\b/i;

export const isCodexModelInvalid = (message: string): boolean => isModelRefusalText(message, CODEX_MODEL_UNSUPPORTED);
