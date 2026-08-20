import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { compareUnrankedModelIds, type EndpointConfig, type Model, ModelSchema } from "@intentic/sandbox-contract";
import { z } from "zod";
import { localTolerantFetch } from "../platform/local-tls.js";
import { endpointHeaders, versionedBase } from "./endpoint-config.js";

/* WHAT AN ENDPOINT SERVES, read from the server itself, and from nowhere else.
 *
 * Every other provider's catalog ends in a compile-time seed floor, because we know who Anthropic and xAI are and
 * roughly what they publish. Here we know nothing: the server is whatever the user pointed us at. So the ladder
 * is one rung shorter, live discovery, then the last list this endpoint answered with, and its bottom is an
 * EMPTY catalog, which is the honest report that the server has never told us anything. Inventing a floor would
 * mean offering models that may not exist on this particular server, and a picker row that 404s on send is worse
 * than a row that is absent.
 *
 * The persisted rung is not a nicety: the translator's config is rendered from these lists (translator.ts), and
 * the daemon renders it at boot and on every proxy restart. Without a last-known-good on disk, a model server
 * that happens to be down at that moment would take the user's working endpoint out of the config entirely, and
 * it would stay out until something asked again.
 *
 * Ordering is compareUnrankedModelIds, as for every OpenAI-compatible catalog: these endpoints publish a SET in
 * registry order, so the id-derived rule is the only thing that puts the frontier model at the head, and the
 * head is what a fresh conversation seeds. */

export interface EndpointCatalog {
    // This endpoint's models, newest/strongest first. `default` is "" exactly when `models` is empty.
    readonly models: (id: string, config: EndpointConfig) => Promise<{ models: Model[]; default: string }>;
    // Drop an endpoint's cache + persisted list, its config changed, or it was removed.
    readonly forget: (id: string) => Promise<void>;
}

// Short, because the whole point of a self-configured endpoint is that the user is iterating on it: pulling a
// new model into Ollama and not seeing it for an hour reads as the integration being broken.
const MODELS_TTL_MS = 60_000;
// A model server on the docker host answers in milliseconds; one across the internet may not. Long enough for a
// cold gateway, short enough that a dead endpoint doesn't hold up the translator render at boot.
const DISCOVERY_TIMEOUT_MS = 10_000;

// The non-chat rows an inference server lists beside its chat models. Same filter the Kimi catalog applies, for
// the same reason: an embedding model in the picker is a row whose every turn fails.
const isChatModel = (model: Model): boolean => !/(embedding|embed|whisper|tts|audio|rerank|moderation|image-generation)/i.test(model.id);

/* Both protocols answer `GET {base}/v1/models` with `{data: [{id, …}]}`. OpenAI's shape, which Anthropic's own
 * REST catalog also follows (adding `display_name`). So one reader covers both, and a server that publishes a
 * display name gets a named row while one that publishes bare ids renders label-only. Nothing here is curated:
 * whatever the server says about a model is what the picker shows. */
const ModelsResponseSchema = z.object({ data: z.array(z.object({ id: z.string().min(1), display_name: z.string().optional() })) });

const discover = async (config: EndpointConfig, fetchImpl: typeof fetch): Promise<Model[]> => {
    const response = await fetchImpl(`${versionedBase(config.baseUrl)}/models`, {
        headers: endpointHeaders(config),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return [];
    }
    const parsed = ModelsResponseSchema.safeParse(await response.json().catch(() => undefined));
    if (!parsed.success) {
        return [];
    }
    return parsed.data.data.map((entry) => ({ id: entry.id, label: entry.display_name ?? entry.id }));
};

const ordered = (models: readonly Model[]): { models: Model[]; default: string } => {
    const list = models.filter(isChatModel).toSorted((left, right) => compareUnrankedModelIds(left.id, right.id));
    return { models: list, default: list[0]?.id ?? "" };
};

/* `fetchImpl` is injectable for the reason every catalog here injects it: the real read reaches whatever URL the
 * test's fixture names, and a test that merely omits a config would otherwise hit a live server on the machine
 * running it.
 *
 * Its DEFAULT tolerates a self-signed certificate on localhost and nowhere else (../platform/local-tls.ts),
 * because two of the endpoints this probes are local by construction: a model server on the docker host, and
 * the free trial pointed at a platform being developed on the same machine. Plain fetch refuses both, and the
 * refusal arrives here as an empty catalog, indistinguishable from a server that published nothing. */
export const createEndpointCatalog = (persistDir: string, fetchImpl: typeof fetch = localTolerantFetch): EndpointCatalog => {
    const cache = new Map<string, { value: { models: Model[]; default: string }; expiresAt: number }>();
    const persistPath = (id: string): string => join(persistDir, `${id}.json`);

    // Parsed through the wire schema rather than trusted, the file outlives builds, so a record written by an
    // older daemon (or a truncated write) must read as "nothing known", never reach the picker half-formed.
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
            // Uncached, so the next read re-probes rather than pinning a stale list for a minute after the server
            // comes back, the same rule claude-models.ts applies to its own degraded rung.
            return ordered(await readPersisted(id));
        },
        forget: async (id) => {
            cache.delete(id);
            await rm(persistPath(id), { force: true });
        },
    };
};
