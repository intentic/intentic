/* The Google channel's model catalog discovery. Google publishes no Anthropic-protocol endpoint, so a turn on
 * this provider always runs on the Claude Code harness pointed at the bundled translator (CLIProxyAPI), which
 * holds the user's Google account and re-serves the channel behind an Anthropic-compatible endpoint. That makes
 * the translator's own model endpoints the only catalog source worth consulting: they report exactly the ids the
 * connected account can drive, and it is the same list the turn will be routed against.
 *
 * The channel is Antigravity. Google's own agent product, and it vends MORE THAN GEMINI: Claude Opus/Sonnet
 * and GPT-OSS ride the same plain Google sign-in. So membership is decided by `owned_by`, the channel the
 * translator itself stamps on each model, rather than by an id prefix: a `/^gemini/` filter dropped the strongest
 * models a free Google account can reach, purely because of how they are named. */

// A model the user could chat with, as opposed to the image/audio/embedding endpoints Google ships beside them
// under the same channel. Named ids only, this is the one membership rule the seed floor can be checked against.
export const isChatModel = (id: string): boolean => !/(image|embedding|imagen|tts|audio|veo|moderation)/i.test(id);

/* ONE MODEL ON THE GOOGLE CHANNEL, and why the modalities are part of its identity rather than a detail.
 *
 * The OpenCode runtime (opencode.ts) registers this channel as a CUSTOM provider pointed at a loopback URL, so
 * there is no models.dev row behind it and every capability it does not declare defaults to false. That default
 * is what made a screenshot invisible on every Google model: `input.image` false, so OpenCode dropped the image
 * out of the request, the model got "Image read successfully" and nothing else, and said it could not see it.
 *
 * The translator publishes `supportedInputModalities` per model, which is the only truthful source for this,
 * so it is discovered with the id and the label rather than guessed from the id or hardcoded per family. */
export interface GeminiModel {
    readonly id: string;
    readonly label: string;
    // What the channel accepts on the way IN.
    readonly inputModalities: readonly InputModality[];
}

/* The input modalities the OpenCode runtime's model config understands, which is the vocabulary this whole
 * field is written in: the point of discovering a modality is to declare it there, so a word that cannot be
 * declared is not worth carrying. Anything else the channel invents is dropped rather than passed through, an
 * unknown name in the provider config is a boot-time schema failure for the whole runtime, which would cost
 * Grok its server too (one `opencode serve` drives both providers). */
export type InputModality = "text" | "image" | "audio" | "video" | "pdf";

const KNOWN_MODALITIES: readonly InputModality[] = ["text", "image", "audio", "video", "pdf"];

const isKnownModality = (modality: string): modality is InputModality => (KNOWN_MODALITIES as readonly string[]).includes(modality);

/* WHAT A MODEL MISSING FROM THE PUBLISHED LIST IS ASSUMED TO TAKE, and why it is not just text.
 *
 * Being wrong in the text-only direction is SILENT: the image is dropped somewhere inside OpenCode and the
 * model tells the user it cannot see, which is the bug this whole field exists to end. Being wrong the other
 * way is LOUD: the upstream rejects the request and the turn surfaces an error naming it. On this channel image
 * input is also the overwhelming norm (the text-only ones are a handful of GPT-OSS/Kimi ids), so the assumption
 * is usually right as well as safely wrong. */
const ASSUMED_MODALITIES: readonly InputModality[] = ["text", "image"];

// The translator's own name for the Google channel (`gemini` is this app's wire id for the same thing, see
// CLIPROXY_PROVIDER in translator.ts).
const CHANNEL = "antigravity";

// The never-empty floor for the catalog: served only when live discovery yields nothing AND no last-known-good
// catalog was persisted (no Google account connected yet, or a translator that is still booting). These are ids
// the pinned CLIProxyAPI serves on the channel, strongest first. It doubles as the picker's SHOP WINDOW, with
// nothing connected this is the list a user sees under "Free · Google sign-in", so it names what the sign-in
// actually buys rather than a token placeholder. Discovery records the account's real catalog, so a stale seed
// costs at most one refresh.
export const SEED_GEMINI_MODELS: readonly GeminiModel[] = [
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", inputModalities: ["text", "image"] },
    { id: "gemini-pro-agent", label: "Gemini 3.1 Pro (High)", inputModalities: ["text", "image", "audio", "video"] },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", inputModalities: ["text", "image"] },
    { id: "gemini-3-flash-agent", label: "Gemini 3.5 Flash (High)", inputModalities: ["text", "image", "audio", "video"] },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", inputModalities: ["text"] },
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

/* The vendor's own display names AND accepted input modalities, keyed by id. The OpenAI-compatible /v1/models
 * carries the channel but neither of these; the Gemini-shaped /v1beta/models carries both but not the channel,
 * so the catalog is the join of the two.
 *
 * The name matters: humanizing alone renders "gemini-pro-agent" as "Gemini Pro Agent", a model that does not
 * exist, where the translator publishes "Gemini 3.1 Pro (High)". The modalities matter for a harder reason,
 * see GeminiModel: they are what stops the OpenCode runtime declaring every Google model blind. */
const publishedModels = async (
    translatorUrl: string,
    token: string,
    fetchImpl: typeof fetch,
): Promise<Map<string, { label?: string; inputModalities?: readonly InputModality[] }>> => {
    const json = await getJson<{ models?: { name?: string; displayName?: string; supportedInputModalities?: string[] }[] }>(
        `${base(translatorUrl)}/v1beta/models`,
        token,
        fetchImpl,
    );
    const published = new Map<string, { label?: string; inputModalities?: readonly InputModality[] }>();
    for (const model of json?.models ?? []) {
        const id = model.name?.replace(/^models\//, "");
        if (id === undefined) {
            continue;
        }
        const modalities = (model.supportedInputModalities ?? []).filter(isKnownModality);
        published.set(id, {
            ...(model.displayName !== undefined && model.displayName !== "" ? { label: model.displayName } : {}),
            // An empty list is "published nothing usable" rather than "takes nothing", so it is left absent and
            // the assumption below applies: a model that takes no input at all is not a model anyone can chat with.
            ...(modalities.length > 0 ? { inputModalities: modalities } : {}),
        });
    }
    return published;
};

// The Google channel's chat models, labelled and described as the translator publishes them; [] on non-ok /
// parse error so the caller can fall through to the persisted/seed catalog.
export const discoverGeminiModels = async (
    translatorUrl: string,
    translatorToken: string,
    fetchImpl: typeof fetch = fetch,
): Promise<GeminiModel[]> => {
    const [catalog, published] = await Promise.all([
        getJson<{ data?: { id: string; owned_by?: string }[] }>(`${base(translatorUrl)}/v1/models`, translatorToken, fetchImpl),
        publishedModels(translatorUrl, translatorToken, fetchImpl),
    ]);
    return (catalog?.data ?? [])
        .filter((model) => model.owned_by === CHANNEL && isChatModel(model.id))
        .map((model) => ({
            id: model.id,
            label: published.get(model.id)?.label ?? humanizeModelId(model.id),
            inputModalities: published.get(model.id)?.inputModalities ?? ASSUMED_MODALITIES,
        }));
};
