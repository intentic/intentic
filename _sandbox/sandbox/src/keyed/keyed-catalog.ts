import { compareUnrankedModelIds, keyEndpointOf, type KeyProvider, type Model } from "@intentic/sandbox-contract";
import { z } from "zod";
import { discoveredCatalog } from "../agent/model-catalog.js";
import type { JsonFile } from "../store/json-file.js";
import type { KeyedStore } from "./keyed-credentials.js";

/* WHAT A KEYED PROVIDER SERVES, read from the vendor's own OpenAI-compatible `/models` with a connected
 * account's key, on the shared ladder (live → the last list this provider answered with → a compile-time floor).
 *
 * THE FLOOR EXISTS HERE AND NOT FOR AN `endpoint` CAPABILITY, and the difference is knowledge. An endpoint is
 * whatever server the user pointed us at, so inventing models for it would mean offering rows that may not
 * exist on that particular box. Here we know exactly whose API this is, so a fresh sandbox whose key was pasted
 * ten seconds ago can offer the right two rows instead of a spinner, and the very next read replaces them with
 * whatever the account can actually reach.
 *
 * THE CATALOG IS READ OVER THE OPENAI SURFACE WHILE TURNS RUN ON THE ANTHROPIC ONE, and that is not an
 * inconsistency to tidy away: both vendors publish `GET …/models` on their OpenAI-compatible root and neither
 * publishes a catalog on the Messages endpoint. The two roots are held together on the provider's spec row
 * (ProviderAuth's `anthropicBase` and `catalogBase`) precisely so nobody has to remember that one is read and
 * the other dialled.
 *
 * ONE IMPLEMENTATION FOR EVERY KEYED PROVIDER: what varies is two URLs, a seed list and which store holds the
 * key, all of which arrive as arguments. A third keyed provider adds a spec row and a seed, not a file. */

// The OpenAI catalog shape both vendors answer with. `display_name` is not in OpenAI's own schema; it is read
// where a vendor sends it (Anthropic's REST catalog does) and its absence renders a label-only row, which is
// the honest answer rather than a name invented here.
const ModelsResponseSchema = z.object({
    data: z.array(z.object({ id: z.string().min(1), display_name: z.string().optional() })),
});

// Short, because a keyed provider's catalog moves when the vendor ships, not when the user edits something, and
// a minute is what every other provider's catalog here uses.
const MODELS_TTL_MS = 60_000;
// A vendor API across the internet, not a model server on the docker host. Long enough for a cold edge, short
// enough that an outage does not hold a picker open.
const DISCOVERY_TIMEOUT_MS = 10_000;

// The non-chat rows a vendor lists beside its chat models. Same filter the Kimi and endpoint catalogs apply,
// for the same reason: an embedding model in the picker is a row whose every turn fails.
const isChatModel = (model: Model): boolean => !/(embedding|embed|whisper|tts|audio|rerank|moderation|image-generation)/i.test(model.id);

/* WHAT TO CALL A MODEL WHOSE VENDOR PUBLISHED NO NAME. The id is what turns dial, so it is never touched; this
 * is only the row's text. A repo-qualified id keeps its last segment, because the owner is not what
 * distinguishes one row from the next. */
const labelFor = (id: string): string => (id.split("/").at(-1) ?? "") || id;

/* CLIProxyAPI publishes a set in registry order and so do these vendors: `/models` hands ids back in whatever
 * order the registry iterated, which is not a preference. So the order is derived from the ids
 * (compareUnrankedModelIds), which puts the frontier generation first, and the head of that list is the model a
 * fresh conversation opens on. */
const toCatalog = (models: readonly Model[], seed: readonly Model[]): { models: Model[]; default: string } => {
    const list = models.filter(isChatModel).toSorted((left, right) => compareUnrankedModelIds(left.id, right.id));
    // Never empty by construction: the ladder only renders this with a live list, the persisted list, or the
    // seed, and the seed is non-empty for every keyed provider (asserted by the registry's own test). The
    // fallback is here so a filter that removed every row cannot produce a default nothing serves.
    const ordered = list.length > 0 ? list : [...seed];
    return { models: ordered, default: ordered[0]?.id ?? "" };
};

export interface KeyedCatalog {
    readonly models: () => Promise<{ models: Model[]; default: string }>;
    // Drop the cached answer. Called when the last account of this provider is disconnected, so the picker
    // stops offering a catalog read with a key that is gone.
    readonly forget: () => void;
}

export const createKeyedCatalog = (input: {
    readonly provider: KeyProvider;
    readonly store: Pick<KeyedStore, "credentials">;
    readonly seed: readonly Model[];
    // The last-known-good list. A vendor blip at boot must not empty a working picker, and unlike the local
    // translator these APIs are a network away, so the file rung genuinely earns its place here.
    readonly file: JsonFile<Model[]>;
    readonly fetchImpl?: typeof fetch;
}): KeyedCatalog => {
    const fetchImpl = input.fetchImpl ?? fetch;
    const endpoint = keyEndpointOf(input.provider);

    const discover = async (): Promise<Model[]> => {
        // No key, no catalog: the ladder reads an empty list as "nothing usable right now", caches nothing, and
        // renders the persisted list or the seed. Which is exactly right for a provider nobody has connected —
        // the picker shows what it WOULD serve, under a badge saying what it costs to unlock.
        const credentials = await input.store.credentials();
        const key = credentials[0]?.apiKey;
        if (endpoint === undefined || key === undefined) {
            return [];
        }
        const response = await fetchImpl(`${endpoint.catalogBase}/models`, {
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
        store: input.file,
        toStored: (models: readonly Model[]) => [...models],
        seed: input.seed,
        fromLive: (models) => toCatalog(models, input.seed),
        fromStored: (models) => toCatalog(models, input.seed),
    });
    return { models: catalog.models, forget: catalog.forget };
};
