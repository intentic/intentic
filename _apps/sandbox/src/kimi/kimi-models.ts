/* Kimi (Moonshot) model catalog + endpoints. Kimi speaks the Anthropic Messages protocol, so a Kimi turn runs
 * on the Claude Code harness (agent.ts runAgent) pointed at MOONSHOT_ANTHROPIC_BASE and authenticated with the
 * user's API key — no separate runtime. Model DISCOVERY uses Moonshot's OpenAI-compatible /v1/models with the
 * same key.
 *
 * VERIFY the two base URLs against Moonshot's current docs before shipping to users — Moonshot serves a global
 * (.ai) and a mainland-China (.cn) endpoint, and the Anthropic-compatible path may differ by plan. They're
 * isolated here so a correction is a one-line change. */
export const MOONSHOT_ANTHROPIC_BASE = "https://api.moonshot.ai/anthropic";
const MOONSHOT_API_BASE = "https://api.moonshot.ai/v1";
const MOONSHOT_MODELS_URL = `${MOONSHOT_API_BASE}/models`;

// The never-empty floor for the catalog: served only when live discovery yields nothing AND no last-known-good
// catalog was persisted (a fresh, offline, or non-enumerating key). Stable Kimi K2 family ids; if the account
// wants a dated/renamed variant, discovery records the real catalog, so a stale seed costs at most one refresh.
export const SEED_KIMI_MODELS: readonly string[] = ["kimi-k2-0711-preview", "kimi-k2-turbo-preview"];

const authHeader = (apiKey: string): Record<string, string> => ({ authorization: `Bearer ${apiKey}` });

// A raw Kimi model id → a display label matching the other providers' polish (kimi-k2-turbo-preview → "Kimi K2
// Turbo Preview"). Title-cases the hyphen-split tokens; the "k2" family tag uppercases to "K2".
export const humanizeModelId = (id: string): string =>
    id
        .split("-")
        .map((token) => (token === "" ? token : /^k\d+$/i.test(token) ? token.toUpperCase() : token[0]!.toUpperCase() + token.slice(1)))
        .join(" ");

// Moonshot's /v1/models lists only chat models today, but guard anyway: keep the kimi/moonshot chat families and
// drop any non-chat suffix a future release might add (embeddings/vision-only/audio), mirroring the codex filter.
export const isChatModel = (id: string): boolean => /kimi|moonshot/i.test(id) && !/(embedding|whisper|tts|audio|vision-only|moderation)/i.test(id);

// GET Moonshot's OpenAI-compatible model list ({ data: [{id}] }); [] on non-ok / parse error so the caller can
// fall through to the persisted/seed catalog. Filtered to chat ids.
export const discoverKimiModels = async (apiKey: string, fetchImpl: typeof fetch = fetch): Promise<{ id: string; label: string }[]> => {
    const response = await fetchImpl(MOONSHOT_MODELS_URL, { headers: authHeader(apiKey) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return [];
    }
    const json = (await response.json().catch(() => undefined)) as { data?: { id: string }[] } | undefined;
    return (json?.data ?? [])
        .map((model) => model.id)
        .filter(isChatModel)
        .map((id) => ({ id, label: humanizeModelId(id) }));
};
