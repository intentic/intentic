// Model catalog discovery for the Google channel (Antigravity), reached only through the translator (CLIProxyAPI) since
// Google publishes no Anthropic endpoint; the translator's own model list is the catalog. Antigravity vends more than
// Gemini (Claude Opus/Sonnet, GPT-OSS too), so membership is decided by `owned_by`, not an id prefix.
import { getJson, humanizeModelId } from "../../agent/models/model-discovery.js";

// A model the user can chat with, not one of the image/audio/embedding endpoints Google ships alongside it.
export const isChatModel = (id: string): boolean => !/(image|embedding|imagen|tts|audio|veo|moderation)/i.test(id);

// Modalities are part of a model's identity, not a detail: OpenCode defaults an undeclared capability to false, which
// silently drops an image from the request rather than erroring. Discovered from the translator's own
// supportedInputModalities per model, not guessed from the id.
export interface GeminiModel {
    readonly id: string;
    readonly label: string;
    readonly inputModalities: readonly InputModality[];
}

// Vocabulary OpenCode's model config understands; an unlisted modality is dropped rather than passed through, since an
// unknown name there is a boot-time schema failure for the whole runtime (Grok's server included, one `opencode serve`
// drives both).
export type InputModality = "text" | "image" | "audio" | "video" | "pdf";

const KNOWN_MODALITIES: readonly InputModality[] = ["text", "image", "audio", "video", "pdf"];

const isKnownModality = (modality: string): modality is InputModality => (KNOWN_MODALITIES as readonly string[]).includes(modality);

// Assumes image support when unlisted: guessing text-only fails silently, guessing image fails loudly instead.
const ASSUMED_MODALITIES: readonly InputModality[] = ["text", "image"];

// The translator's own name for the Google channel; this app's wire id for the same channel is `gemini`.
const CHANNEL = "antigravity";

// Served only when discovery and the persisted catalog are empty; strongest first, also the picker's display.
export const SEED_GEMINI_MODELS: readonly GeminiModel[] = [
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", inputModalities: ["text", "image"] },
    { id: "gemini-pro-agent", label: "Gemini 3.1 Pro (High)", inputModalities: ["text", "image", "audio", "video"] },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", inputModalities: ["text", "image"] },
    { id: "gemini-3-flash-agent", label: "Gemini 3.5 Flash (High)", inputModalities: ["text", "image", "audio", "video"] },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", inputModalities: ["text"] },
];

const base = (translatorUrl: string): string => translatorUrl.replace(/\/$/, "");

// Display names and input modalities keyed by id, from /v1beta/models (which lacks the channel but has both); the
// catalog joins this with /v1/models's channel tag. Humanizing an id alone gets the name wrong (`gemini-pro-agent`
// isn't "Gemini Pro Agent").
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
            // An empty list means nothing usable was published, not that the model takes no input; left absent instead.
            ...(modalities.length > 0 ? { inputModalities: modalities } : {}),
        });
    }
    return published;
};

// Google channel's chat models, labelled as the translator publishes them; returns [] on a non-ok or parse error so the
// caller falls through to the persisted/seed catalog.
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
