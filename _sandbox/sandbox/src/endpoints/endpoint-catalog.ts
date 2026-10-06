import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareUnrankedModelIds, type EndpointConfig, type HelperOnly, LOCAL_MODELS, type Model, ModelSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { opt } from "../opt.js";
import { cacheFile } from "../store/open-document.js";
import { localTolerantFetch } from "../system/tls/local-tls.js";
import { endpointHeaders, unversionedBase, versionedBase } from "./endpoint-config.js";

// Reads what an endpoint serves from the server itself, with no compile-time seed floor: live discovery, then the last
// persisted list, then an empty catalog, never an invented one. Persisted because the translator renders its config
// from this list at boot; ordering is compareUnrankedModelIds since these endpoints publish an unranked set.

export interface EndpointCatalog {
    // This endpoint's models, newest/strongest first; default is "" exactly when models is empty.
    readonly models: (id: string, config: EndpointConfig) => Promise<{ models: Model[]; default: string }>;
    // Drops an endpoint's cache and persisted list, since its config changed or it was removed.
    readonly forget: (id: string) => Promise<void>;
}

// Short: a self-configured endpoint is one the user is actively iterating on, an hour's lag reads as broken.
const MODELS_TTL_MS = 60_000;
// Long enough for a cold remote gateway, short enough that a dead endpoint doesn't hold up the boot render.
const DISCOVERY_TIMEOUT_MS = 10_000;

// Non-chat rows to exclude from the picker, same filter and reason as the Kimi catalog: a chat turn against them fails.
const isChatModel = (model: Model): boolean => !/(embedding|embed|whisper|tts|audio|rerank|moderation|image-generation)/i.test(model.id);

// Both protocols answer GET {base}/v1/models the same; a display_name gets a named row, otherwise label-only.
const ModelsResponseSchema = z.object({
    data: z.array(
        z.object({
            id: z.string().min(1),
            display_name: z.string().optional(),
            // vLLM's per-row field; beats the server-wide probe below when present.
            max_model_len: z.number().positive().optional(),
        }),
    ),
});

// llama.cpp's /props, read outside /v1 at server-root; 404 (vLLM, a remote gateway) means both facts are unknown. Each is
// parsed on its own, so a shape we don't know in one leaves the other standing.
// The per-slot window, not the weights' context.
const WindowPropsSchema = z.object({
    default_generation_settings: z.object({ n_ctx: z.number().positive().optional() }).optional(),
    n_ctx: z.number().positive().optional(),
});
// What the chat template can express (llama.cpp's common/jinja/caps.cpp, on /props since before the pinned b11146).
// llama.cpp parses a reply's tool calls only when `supports_tool_calls` holds, and a request's tools are dropped without
// a word when it does not (ggml-org/llama.cpp#27129), so false is the one answer that gates; absent or true does not.
const CapsPropsSchema = z.object({ chat_template_caps: z.object({ supports_tool_calls: z.boolean().optional() }) });

interface ServedProps {
    readonly window?: number;
    readonly toolCalls?: boolean;
}

const servedProps = async (config: EndpointConfig, fetchImpl: typeof fetch): Promise<ServedProps> => {
    const response = await fetchImpl(`${unversionedBase(config.baseUrl)}/props`, {
        headers: endpointHeaders(config),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return {};
    }
    const body: unknown = await response.json().catch(() => undefined);
    const window = WindowPropsSchema.safeParse(body);
    const caps = CapsPropsSchema.safeParse(body);
    const served = window.success ? (window.data.default_generation_settings?.n_ctx ?? window.data.n_ctx) : undefined;
    const toolCalls = caps.success ? caps.data.chat_template_caps.supports_tool_calls : undefined;
    return { ...opt("window", served), ...opt("toolCalls", toolCalls) };
};

// The curated rungs sold as too small for a turn, by weights file: llama-server lists its model under the path it
// loaded, so the file name is what matches, whichever card (or hand-added endpoint) serves those weights.
const fileOf = (id: string): string => id.split("/").at(-1) ?? "";
const INSTANT_FILES: ReadonlySet<string> = new Set(LOCAL_MODELS.filter((choice) => choice.tier === "instant").map((choice) => fileOf(choice.id)));

// Only a positive answer makes a row helper-only; a server that says nothing about tools stays usable as it was.
export const helperOnlyOf = (id: string, toolCalls: boolean | undefined): HelperOnly | undefined => {
    if (toolCalls === false) {
        return "no-tool-calls";
    }
    return INSTANT_FILES.has(fileOf(id)) ? "instant-tier" : undefined;
};

// Why a turn on a helper-only row was refused, in words the owner can act on: why this model cannot, what to do for the
// chat, and where the model is still useful.
export const helperOnlyRefusal = (label: string, reason: HelperOnly): string => {
    const why =
        reason === "no-tool-calls"
            ? `${label} cannot call tools: its server reports a chat template with no tool calling, and an agent turn is made of tool calls`
            : `${label} is the small local model kept for quick jobs, too small to drive an agent turn`;
    return (
        `${why}, so nothing was sent. Pick a model that can for this chat. This one can still write commit messages, ` +
        `session titles and other one-shot jobs: set it for those in Sandbox ▸ Agent ▸ Models.`
    );
};

// The row's label, never the id: a bare id stands as-is, a path-shaped one (llama-server's weights path) keeps only the
// last segment, minus .gguf.
const labelFor = (id: string): string => {
    const name = (id.split("/").at(-1) ?? "").replace(/\.gguf$/i, "");
    return name === "" ? id : name;
};

const discover = async (config: EndpointConfig, fetchImpl: typeof fetch): Promise<Model[]> => {
    // Both reads at once: the props probe is independent of the models list, so silence costs one timeout.
    const [response, props] = await Promise.all([
        fetchImpl(`${versionedBase(config.baseUrl)}/models`, {
            headers: endpointHeaders(config),
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        }).catch(() => undefined),
        servedProps(config, fetchImpl),
    ]);
    if (response === undefined || !response.ok) {
        return [];
    }
    const parsed = ModelsResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
        return [];
    }
    return parsed.data.data.map((entry) => {
        const model: Model = { id: entry.id, label: entry.display_name ?? labelFor(entry.id) };
        // Row's own number first (vLLM), then the server-wide one (llama.cpp); absent means unknown downstream.
        const contextWindow = entry.max_model_len ?? props.window;
        if (contextWindow !== undefined) {
            model.contextWindow = contextWindow;
        }
        // Server-wide like the window: one llama-server serves one model, with one template.
        const helperOnly = helperOnlyOf(entry.id, props.toolCalls);
        if (helperOnly !== undefined) {
            model.helperOnly = helperOnly;
        }
        return model;
    });
};

// The default is what a turn that names no model runs on, so it is the first row that can run one; a server serving
// only helper-only rows still names its first, which the turn's refusal then explains.
const ordered = (models: readonly Model[]): { models: Model[]; default: string } => {
    const list = models.filter(isChatModel).toSorted((left, right) => compareUnrankedModelIds(left.id, right.id));
    return { models: list, default: (list.find((model) => model.helperOnly === undefined) ?? list[0])?.id ?? "" };
};

// fetchImpl is injectable so a test never reaches a live server; its default tolerates a self-signed cert on localhost
// only, since local model servers and a dev-platform trial live there.
export const createEndpointCatalog = (persistDir: string, fetchImpl: typeof fetch = localTolerantFetch): EndpointCatalog => {
    const cache = new Map<string, { value: { models: Model[]; default: string }; expiresAt: number }>();
    const persistPath = (id: string): string => join(persistDir, `${id}.json`);

    // Parsed through the schema, not trusted: a record from an older daemon or a truncated write reads as nothing
    // known, never half-formed. Written atomically, so a crash mid-write can't leave the truncated record either.
    const persisted = (id: string) => cacheFile<Model[]>(persistPath(id), { parse: (raw) => z.array(ModelSchema).safeParse(raw).data, fallback: () => [] });

    return {
        models: async (id, config) => {
            const cached = cache.get(id);
            if (cached !== undefined && Date.now() < cached.expiresAt) {
                return cached.value;
            }
            const discovered = await discover(config, fetchImpl);
            if (discovered.length > 0) {
                const value = ordered(discovered);
                await mkdir(dirname(persistPath(id)), { recursive: true });
                await persisted(id).update(() => value.models);
                cache.set(id, { value, expiresAt: Date.now() + MODELS_TTL_MS });
                return value;
            }
            // Uncached, so the next read re-probes instead of pinning a stale list.
            return ordered(await persisted(id).read());
        },
        forget: async (id) => {
            cache.delete(id);
            await rm(persistPath(id), { force: true });
        },
    };
};
