/* xAI's live model catalog, the true source of valid Grok ids. OpenCode's provider.list() serves a static
 * models.dev snapshot (with no refresh API) whose non-deprecated xai models can be empty and whose default can be
 * a retired id (grok-code-fast-1) xAI rejects. We resolve the catalog straight from xAI instead, with a fallback
 * for subscription-OAuth tokens: those don't reliably enumerate models via the REST endpoints, but xAI still
 * NAMES the account's valid models in its "Model not found … Did you mean: a, b, c" rejection, the authoritative
 * list. All queries use the OAuth access token OpenCode persisted (the same token turns authenticate with). */
import { authHeader, listModels, suggestedModels } from "../agent/model-discovery.js";

const XAI_BASE = "https://api.x.ai/v1";
const XAI_MODELS_URL = `${XAI_BASE}/models`;
const XAI_LANGUAGE_MODELS_URL = `${XAI_BASE}/language-models`;
const XAI_CHAT_URL = `${XAI_BASE}/chat/completions`;
// A deliberately-invalid model id, used only to elicit xAI's "Did you mean: …" list when the model endpoints
// return nothing. It never runs inference, xAI rejects the unknown id before generating.
const PROBE_MODEL = "intentic-model-probe";

// The never-empty floor for xaiModels(): served only when live discovery yields nothing AND no last-known-good
// catalog was persisted (a fresh, offline, or expired-token daemon). These are stable Grok family names; if the
// account actually wants a dated variant (e.g. grok-4.20-0309-reasoning), the first turn's "Did you mean"
// rejection self-heals the pinned model AND records the real catalog (see grok-agent's runner). So a stale seed
// costs at most one silent server-side retry, never a user-visible bounce.
export const SEED_XAI_MODELS: readonly string[] = ["grok-4", "grok-3"];

// xAI's generic /v1/models lists media-generation models (image/video, e.g. grok-imagine-video, grok-2-image)
// alongside chat models, but those 400 on the chat endpoint ("… is a video model …"). Keep only chat/coding ids.
// "vision" chat models (image INPUT, text output, e.g. grok-2-vision) don't match, so they're correctly kept.
export const isChatModel = (id: string): boolean => !/imagine|image|video/i.test(id);

// The valid model ids xAI names in a "Model not found … Did you mean: a, b, c?" rejection. Every xAI chat model
// is a `grok-…`, so the pattern can name the family and leave the surrounding prose out by construction.
export const parseModelSuggestions = (message: string): string[] => suggestedModels(message, /grok[\w.-]+/gi);

// Resolve xAI's model catalog for this account. Tries the REST catalogs first (OpenAI-compatible /models, then
// xAI's native /language-models); if both are empty, as they are for a subscription-OAuth token, probes the
// chat endpoint with an invalid model and reads the valid ids out of xAI's rejection. [] only if xAI names none.
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
