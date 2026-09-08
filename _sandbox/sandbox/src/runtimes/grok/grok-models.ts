// xAI's live model catalog: OpenCode's provider.list() serves a static models.dev snapshot that can be empty for xai or
// default to a retired id xAI rejects. Resolves straight from xAI instead; a subscription-OAuth token can't enumerate
// models via REST, so this falls back to probing chat and reading valid ids out of the "Did you mean" rejection.
// Queries use the OAuth access token OpenCode persisted.
import { authHeader, listModels, suggestedModels } from "../../agent/models/model-discovery.js";

const XAI_BASE = "https://api.x.ai/v1";
const XAI_MODELS_URL = `${XAI_BASE}/models`;
const XAI_LANGUAGE_MODELS_URL = `${XAI_BASE}/language-models`;
const XAI_CHAT_URL = `${XAI_BASE}/chat/completions`;
// Deliberately-invalid model id, used only to elicit xAI's "Did you mean" list; never runs inference.
const PROBE_MODEL = "intentic-model-probe";

// Never-empty floor for xaiModels(), served only when live discovery and the persisted catalog are both empty; a stale
// seed self-heals via the first turn's "Did you mean" rejection.
export const SEED_XAI_MODELS: readonly string[] = ["grok-4", "grok-3"];

// Excludes xAI's media-generation models (image/video), which 400 on the chat endpoint; vision chat models (image
// input, text output) aren't matched, so they're kept.
export const isChatModel = (id: string): boolean => !/imagine|image|video/i.test(id);

// Valid model ids xAI names in its "Did you mean: a, b, c?" rejection; every xAI chat model is `grok-…`, so the pattern
// matches the family alone.
export const parseModelSuggestions = (message: string): string[] => suggestedModels(message, /grok[\w.-]+/gi);

// Resolves xAI's model catalog: tries the REST catalogs first (/models, then /language-models), then probes the chat
// endpoint with an invalid model and reads valid ids out of xAI's rejection. Returns [] only if xAI names none.
export const discoverXaiModels = async (accessToken: string, fetchImpl: typeof fetch = fetch): Promise<string[]> => {
    for (const url of [XAI_MODELS_URL, XAI_LANGUAGE_MODELS_URL]) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a ladder: the second endpoint is asked only when the first says nothing
        const ids = (await listModels(url, accessToken, fetchImpl)).map((model) => model.id).filter(isChatModel);
        if (ids.length > 0) {
            return ids;
        }
    }
    const response = await fetchImpl(XAI_CHAT_URL, {
        method: "POST",
        headers: { ...authHeader(accessToken), "content-type": "application/json" },
        body: JSON.stringify({ model: PROBE_MODEL, messages: [{ role: "user", content: "." }], max_tokens: 1 }),
    }).catch(() => undefined);
    if (response === undefined || response.ok) {
        return [];
    }
    const body = (await response.json().catch(() => undefined)) as { error?: { message?: string } | string } | undefined;
    const message = typeof body?.error === "string" ? body.error : (body?.error?.message ?? "");
    return parseModelSuggestions(message).filter(isChatModel);
};
