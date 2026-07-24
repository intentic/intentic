/* Gemini (Google) model catalog discovery. Google publishes no Anthropic-protocol endpoint, so a Gemini turn
 * always runs on the Claude Code harness pointed at the bundled translator (CLIProxyAPI), which holds the
 * user's Google account and re-serves Gemini behind an Anthropic-compatible endpoint. That makes the
 * translator's own OpenAI-compatible /v1/models the only catalog source worth consulting: it reports exactly
 * the ids the connected account can drive, and it is the same list the turn will be routed against. */

// The never-empty floor for the catalog: served only when live discovery yields nothing AND no last-known-good
// catalog was persisted (no Google account connected yet, or a translator that is still booting). Ids the
// pinned CLIProxyAPI serves on the Google channel, strongest first; discovery records the account's real
// catalog, so a stale seed costs at most one refresh — the picker reloads it.
export const SEED_GEMINI_MODELS: readonly string[] = ["gemini-pro-agent", "gemini-3-flash-agent"];

const authHeader = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// A raw Gemini model id → a display label matching the other providers' polish (gemini-3.1-pro-low → "Gemini
// 3.1 Pro Low"). Title-cases the hyphen-split tokens; dotted version segments pass through untouched.
export const humanizeModelId = (id: string): string =>
    id
        .split("-")
        .map((token) => (token === "" ? token : token[0]!.toUpperCase() + token.slice(1)))
        .join(" ");

// The translator serves several upstreams behind one /v1/models, so keep only Google's chat families and drop
// the non-chat ones a Gemini turn can't drive (the image/embedding variants Google ships alongside them).
export const isGeminiModel = (id: string): boolean =>
    /^gemini/i.test(id) && !/(image|embedding|imagen|tts|audio|veo|vision-only|moderation)/i.test(id);

// GET the translator's OpenAI-compatible model list ({ data: [{id}] }) with its local bearer; [] on non-ok /
// parse error so the caller can fall through to the persisted/seed catalog. Filtered to Gemini chat ids.
export const discoverGeminiModels = async (
    translatorUrl: string,
    translatorToken: string,
    fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; label: string }[]> => {
    const url = `${translatorUrl.replace(/\/$/, "")}/v1/models`;
    const response = await fetchImpl(url, { headers: authHeader(translatorToken) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return [];
    }
    const json = (await response.json().catch(() => undefined)) as { data?: { id: string }[] } | undefined;
    return (json?.data ?? [])
        .map((model) => model.id)
        .filter(isGeminiModel)
        .map((id) => ({ id, label: humanizeModelId(id) }));
};
