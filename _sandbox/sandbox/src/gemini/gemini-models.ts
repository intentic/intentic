/* The Google channel's model catalog discovery. Google publishes no Anthropic-protocol endpoint, so a turn on
 * this provider always runs on the Claude Code harness pointed at the bundled translator (CLIProxyAPI), which
 * holds the user's Google account and re-serves the channel behind an Anthropic-compatible endpoint. That makes
 * the translator's own model endpoints the only catalog source worth consulting: they report exactly the ids the
 * connected account can drive, and it is the same list the turn will be routed against.
 *
 * The channel is Antigravity — Google's own agent product — and it vends MORE THAN GEMINI: Claude Opus/Sonnet
 * and GPT-OSS ride the same plain Google sign-in. So membership is decided by `owned_by`, the channel the
 * translator itself stamps on each model, rather than by an id prefix: a `/^gemini/` filter dropped the strongest
 * models a free Google account can reach, purely because of how they are named. */

// A model the user could chat with, as opposed to the image/audio/embedding endpoints Google ships beside them
// under the same channel. Named ids only — this is the one membership rule the seed floor can be checked against.
export const isChatModel = (id: string): boolean => !/(image|embedding|imagen|tts|audio|veo|moderation)/i.test(id);

// The translator's own name for the Google channel (`gemini` is this app's wire id for the same thing — see
// CLIPROXY_PROVIDER in translator.ts).
const CHANNEL = "antigravity";

// The never-empty floor for the catalog: served only when live discovery yields nothing AND no last-known-good
// catalog was persisted (no Google account connected yet, or a translator that is still booting). These are ids
// the pinned CLIProxyAPI serves on the channel, strongest first. It doubles as the picker's SHOP WINDOW — with
// nothing connected this is the list a user sees under "Free · Google sign-in", so it names what the sign-in
// actually buys rather than a token placeholder. Discovery records the account's real catalog, so a stale seed
// costs at most one refresh.
export const SEED_GEMINI_MODELS: readonly { id: string; label: string }[] = [
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)" },
    { id: "gemini-pro-agent", label: "Gemini 3.1 Pro (High)" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
    { id: "gemini-3-flash-agent", label: "Gemini 3.5 Flash (High)" },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
];

const authHeader = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}` });

// A raw model id → a display label, used only where the translator publishes no name of its own
// (gemini-3.1-pro-low → "Gemini 3.1 Pro Low"). Title-cases the hyphen-split tokens; dotted version segments pass
// through untouched.
export const humanizeModelId = (id: string): string =>
    id
        .split("-")
        .map((token) => (token === "" ? token : token[0]!.toUpperCase() + token.slice(1)))
        .join(" ");

const base = (translatorUrl: string): string => translatorUrl.replace(/\/$/, "");

const getJson = async <T>(url: string, token: string, fetchImpl: typeof fetch): Promise<T | undefined> => {
    const response = await fetchImpl(url, { headers: authHeader(token) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return undefined;
    }
    return (await response.json().catch(() => undefined)) as T | undefined;
};

// The vendor's own display names, keyed by id. The OpenAI-compatible /v1/models carries the channel but no name;
// the Gemini-shaped /v1beta/models carries the name but not the channel — so the catalog is the join of the two.
// It matters: humanizing alone renders "gemini-pro-agent" as "Gemini Pro Agent", a model that does not exist,
// where the translator publishes "Gemini 3.1 Pro (High)".
const publishedNames = async (translatorUrl: string, token: string, fetchImpl: typeof fetch): Promise<Map<string, string>> => {
    const json = await getJson<{ models?: { name?: string; displayName?: string }[] }>(`${base(translatorUrl)}/v1beta/models`, token, fetchImpl);
    const names = new Map<string, string>();
    for (const model of json?.models ?? []) {
        const id = model.name?.replace(/^models\//, "");
        if (id !== undefined && model.displayName !== undefined && model.displayName !== "") {
            names.set(id, model.displayName);
        }
    }
    return names;
};

// The Google channel's chat models, labelled as the translator publishes them; [] on non-ok / parse error so the
// caller can fall through to the persisted/seed catalog.
export const discoverGeminiModels = async (
    translatorUrl: string,
    translatorToken: string,
    fetchImpl: typeof fetch = fetch,
): Promise<{ id: string; label: string }[]> => {
    const [catalog, names] = await Promise.all([
        getJson<{ data?: { id: string; owned_by?: string }[] }>(`${base(translatorUrl)}/v1/models`, translatorToken, fetchImpl),
        publishedNames(translatorUrl, translatorToken, fetchImpl),
    ]);
    return (catalog?.data ?? [])
        .filter((model) => model.owned_by === CHANNEL && isChatModel(model.id))
        .map((model) => ({ id: model.id, label: names.get(model.id) ?? humanizeModelId(model.id) }));
};
