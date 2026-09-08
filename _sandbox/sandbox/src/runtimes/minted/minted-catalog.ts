import { compareUnrankedModelIds, type MintedProvider, type MintedVariant, type Model } from "@intentic/sandbox-contract";
import { z } from "zod";
import { discoveredCatalog } from "../../agent/models/model-catalog.js";
import type { JsonFile } from "../../store/json-file.js";
import type { MintedStore } from "./minted-credentials.js";

// What a minted provider serves, read from the vendor's OpenAI-compatible /models with a connected account's key, on
// the shared discovery ladder (live, last-answered, compile-time floor). Catalog reads use the OpenAI surface
// (`catalogBase`) while turns run on the Anthropic one (`anthropicBase`); one catalog per estate, not per provider,
// since a key minted on one of Z.ai's two estates can't read the other's list.

// display_name isn't part of OpenAI's schema; read where a vendor sends it, its absence renders a label-only row rather
// than an invented name.
const ModelsResponseSchema = z.object({
    data: z.array(z.object({ id: z.string().min(1), display_name: z.string().optional() })),
});

// Short: a minted provider's catalog moves when the vendor ships, not when the user edits anything.
const MODELS_TTL_MS = 60_000;
// A vendor API across the internet, not a model server on the docker host. Long enough for a cold edge, short enough
// that an outage does not hold a picker open.
const DISCOVERY_TIMEOUT_MS = 10_000;

// Non-chat rows a vendor lists beside its chat models; an embedding/etc. model in the picker is a row whose every turn
// fails.
const isChatModel = (model: Model): boolean => !/(embedding|embed|whisper|tts|audio|rerank|moderation|image-generation)/i.test(model.id);

// Label for a model with no vendor-published name; the id itself is never touched. A repo-qualified id keeps only its
// last segment.
const labelFor = (id: string): string => (id.split("/").at(-1) ?? "") || id;

// /models returns ids in registry iteration order, not a preference, so the order is derived from the ids instead
// (compareUnrankedModelIds, frontier generation first); the head is what a fresh conversation opens on.
const toCatalog = (models: readonly Model[], seed: readonly Model[]): { models: Model[]; default: string } => {
    const list = models.filter(isChatModel).toSorted((left, right) => compareUnrankedModelIds(left.id, right.id));
    // Never empty: the ladder only calls this with a live, persisted, or seed list, and the seed is non-empty for every
    // provider. The fallback covers a filter that removed every row.
    const ordered = list.length > 0 ? list : [...seed];
    return { models: ordered, default: ordered[0]?.id ?? "" };
};

export interface MintedCatalog {
    readonly models: () => Promise<{ models: Model[]; default: string }>;
    // Drops the cached answer; called on connect/disconnect so the picker doesn't serve a stale credential's catalog.
    readonly forget: () => void;
}

export const createMintedCatalog = (input: {
    readonly provider: MintedProvider;
    readonly variant: MintedVariant;
    readonly store: Pick<MintedStore, "credentials">;
    readonly seed: readonly Model[];
    // Last-known-good list; a vendor blip must not empty a working picker, and these APIs are a real network away.
    readonly file: JsonFile<Model[]>;
    readonly fetchImpl?: typeof fetch;
}): MintedCatalog => {
    const fetchImpl = input.fetchImpl ?? fetch;
    const { variant } = input;

    const discover = async (): Promise<Model[]> => {
        // No credential for this estate ⇒ empty list, which the ladder reads as nothing usable and renders the
        // persisted list or seed instead, so an unconnected provider still shows what it would serve.
        const credentials = await input.store.credentials();
        const key = credentials.find((account) => account.variant === variant.id)?.apiKey;
        if (key === undefined) {
            return [];
        }
        const response = await fetchImpl(`${variant.catalogBase}/models`, {
            headers: { authorization: `Bearer ${key}` },
            signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
        }).catch(() => undefined);
        if (response === undefined || !response.ok) {
            return [];
        }
        const parsed = ModelsResponseSchema.safeParse(await response.json().catch(() => undefined));
        if (!parsed.success) {
            return [];
        }
        return parsed.data.data.map((entry) => ({ id: entry.id, label: entry.display_name ?? labelFor(entry.id) }));
    };

    const catalog = discoveredCatalog({
        ttlMs: MODELS_TTL_MS,
        discover,
        idOf: (model) => model.id,
        store: input.file,
        toStored: (models: readonly Model[]) => [...models],
        seed: input.seed,
        fromLive: (models) => toCatalog(models, input.seed),
        fromStored: (models) => toCatalog(models, input.seed),
    });
    return { models: catalog.models, forget: catalog.forget };
};
