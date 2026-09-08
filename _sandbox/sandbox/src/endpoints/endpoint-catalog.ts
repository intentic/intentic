import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareUnrankedModelIds, type EndpointConfig, type Model, ModelSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { localTolerantFetch } from "../platform/tls/local-tls.js";
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

// llama.cpp's per-slot window, not the weights' context; 404 means unknown, read outside /v1 at server-root.
const PropsSchema = z.object({
    default_generation_settings: z.object({ n_ctx: z.number().positive().optional() }).optional(),
    n_ctx: z.number().positive().optional(),
});

const servedWindow = async (config: EndpointConfig, fetchImpl: typeof fetch): Promise<number | undefined> => {
    const response = await fetchImpl(`${unversionedBase(config.baseUrl)}/props`, {
        headers: endpointHeaders(config),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return undefined;
    }
    const parsed = PropsSchema.safeParse(await response.json().catch(() => undefined));
    return parsed.success ? (parsed.data.default_generation_settings?.n_ctx ?? parsed.data.n_ctx) : undefined;
};

// The row's label, never the id: a bare id stands as-is, a path-shaped one (llama-server's weights path) keeps only the
// last segment, minus .gguf.
const labelFor = (id: string): string => {
    const name = (id.split("/").at(-1) ?? "").replace(/\.gguf$/i, "");
    return name === "" ? id : name;
};

const discover = async (config: EndpointConfig, fetchImpl: typeof fetch): Promise<Model[]> => {
    // Both reads at once: the window probe is independent of the models list, so silence costs one timeout.
    const [response, window] = await Promise.all([
        fetchImpl(`${versionedBase(config.baseUrl)}/models`, {
            headers: endpointHeaders(config),
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        }).catch(() => undefined),
        servedWindow(config, fetchImpl),
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
        const contextWindow = entry.max_model_len ?? window;
        if (contextWindow !== undefined) {
            model.contextWindow = contextWindow;
        }
        return model;
    });
};

const ordered = (models: readonly Model[]): { models: Model[]; default: string } => {
    const list = models.filter(isChatModel).toSorted((left, right) => compareUnrankedModelIds(left.id, right.id));
    return { models: list, default: list[0]?.id ?? "" };
};

// fetchImpl is injectable so a test never reaches a live server; its default tolerates a self-signed cert on localhost
// only, since local model servers and a dev-platform trial live there.
export const createEndpointCatalog = (persistDir: string, fetchImpl: typeof fetch = localTolerantFetch): EndpointCatalog => {
    const cache = new Map<string, { value: { models: Model[]; default: string }; expiresAt: number }>();
    const persistPath = (id: string): string => join(persistDir, `${id}.json`);

    // Parsed through the schema, not trusted: a record from an older daemon or a truncated write reads as nothing
    // known, never half-formed.
    const readPersisted = async (id: string): Promise<Model[]> => {
        try {
            const parsed = z.array(ModelSchema).safeParse(JSON.parse(await readFile(persistPath(id), "utf8")));
            return parsed.success ? parsed.data : [];
        } catch {
            return [];
        }
    };

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
                await writeFile(persistPath(id), JSON.stringify(value.models));
                cache.set(id, { value, expiresAt: Date.now() + MODELS_TTL_MS });
                return value;
            }
            // Uncached, so the next read re-probes instead of pinning a stale list.
            return ordered(await readPersisted(id));
        },
        forget: async (id) => {
            cache.delete(id);
            await rm(persistPath(id), { force: true });
        },
    };
};
