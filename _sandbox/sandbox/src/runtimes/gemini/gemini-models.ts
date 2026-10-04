// Advertised model metadata for the Google channel (Antigravity), reached through the translator (CLIProxyAPI).
// Advertisement is not account availability: gemini-catalog joins this list to Google's credential-scoped metadata.
// Antigravity vends Claude and GPT-OSS beside Gemini, so the channel is decided by `owned_by`, not an id prefix.
import { humanizeModelId } from "@intentic/sandbox-contract";
import { z } from "zod";
import { getJson } from "../../agent/models/model-discovery.js";

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

// OpenCode's id for Gemini through the translator; not "google", OpenCode's own API-key provider, which bypasses the fleet.
export const OPENCODE_GEMINI_PROVIDER = "intentic-gemini";

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

// Display metadata when discovery and the persisted catalog are empty; these rows never prove account availability.
export const SEED_GEMINI_MODELS: readonly GeminiModel[] = [
    { id: "claude-opus-4-6-thinking", label: "Claude Opus 4.6 (Thinking)", inputModalities: ["text", "image"] },
    { id: "gemini-pro-agent", label: "Gemini 3.1 Pro (High)", inputModalities: ["text", "image", "audio", "video"] },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)", inputModalities: ["text", "image"] },
    { id: "gemini-3-flash-agent", label: "Gemini 3.5 Flash (High)", inputModalities: ["text", "image", "audio", "video"] },
    { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)", inputModalities: ["text"] },
];

const base = (translatorUrl: string): string => translatorUrl.replace(/\/$/, "");

// Parse HTTP JSON before catalog membership is trusted. Optional display metadata can be discarded independently.
const AdvertisedCatalog = z.object({ data: z.array(z.object({ id: z.string().min(1), owned_by: z.string().optional() })) });
const PublishedCatalog = z.object({ models: z.array(z.unknown()) });
const PublishedModel = z.object({
    name: z.string(),
    displayName: z.string().optional().catch(undefined),
    supportedInputModalities: z.array(z.string().catch("")).optional().catch(undefined),
});

// Display names and input modalities keyed by id, from /v1beta/models (which lacks the channel but has both); the
// catalog joins this with /v1/models's channel tag. Humanizing an id alone gets the name wrong (`gemini-pro-agent`
// isn't "Gemini Pro Agent").
const publishedModels = async (
    translatorUrl: string,
    token: string,
    fetchImpl: typeof fetch,
): Promise<Map<string, { label?: string; inputModalities?: readonly InputModality[] }>> => {
    const json = await getJson<unknown>(`${base(translatorUrl)}/v1beta/models`, token, fetchImpl);
    const catalog = PublishedCatalog.safeParse(json);
    const published = new Map<string, { label?: string; inputModalities?: readonly InputModality[] }>();
    for (const entry of catalog.success ? catalog.data.models : []) {
        const parsed = PublishedModel.safeParse(entry);
        if (!parsed.success) {
            continue;
        }
        const model = parsed.data;
        const id = model.name.replace(/^models\//, "");
        const modalities = (model.supportedInputModalities ?? []).filter(isKnownModality);
        published.set(id, {
            ...(model.displayName !== undefined && model.displayName !== "" ? { label: model.displayName } : {}),
            // An empty list means nothing usable was published, not that the model takes no input; left absent instead.
            ...(modalities.length > 0 ? { inputModalities: modalities } : {}),
        });
    }
    return published;
};

// Undefined is an unreadable advertisement, not an authoritative empty list. The catalog keeps display metadata in
// that case, but neither a persisted row nor a seed is permission to invoke a model.
const DISCOVERY_DEADLINE_MS = 8_000;

export const discoverGeminiModels = async (
    translatorUrl: string,
    translatorToken: string,
    fetchImpl: typeof fetch = fetch,
): Promise<GeminiModel[] | undefined> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), DISCOVERY_DEADLINE_MS);
    const boundedFetch = Object.assign(
        (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetchImpl(url, { ...init, signal: controller.signal }),
        fetchImpl,
    );
    try {
        const [catalog, published] = await Promise.all([
            getJson<unknown>(`${base(translatorUrl)}/v1/models`, translatorToken, boundedFetch),
            publishedModels(translatorUrl, translatorToken, boundedFetch),
        ]);
        const parsed = AdvertisedCatalog.safeParse(catalog);
        if (!parsed.success) {
            return undefined;
        }
        return parsed.data.data
            .filter((model) => model.owned_by === CHANNEL && isChatModel(model.id))
            .map((model) => ({
                id: model.id,
                label: published.get(model.id)?.label ?? humanizeModelId(model.id),
                inputModalities: published.get(model.id)?.inputModalities ?? ASSUMED_MODALITIES,
            }));
    } finally {
        clearTimeout(timeout);
    }
};
