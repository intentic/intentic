import { join } from "node:path";
import { KEY_PROVIDERS, type KeyProvider, type Model, ModelSchema, providerSpec } from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../agent/provider-module.js";
import { jsonFile } from "../store/json-file.js";
import { createKeyedCatalog, type KeyedCatalog } from "./keyed-catalog.js";
import { fileKeyedStore, type KeyedStore } from "./keyed-credentials.js";

/* EVERYTHING A KEYED PROVIDER CONTRIBUTES TO THE DAEMON, written ONCE and instantiated per provider.
 *
 * These are the Kimi shape — no adapter, because they have no native runtime and `capabilitiesOf` hands both
 * their harnesses to the Claude Code loop, which the claude module contributes — with the one addition Kimi
 * does not need: a credential of their own, because nothing else in this daemon holds it. Kimi's key lives in
 * the translator; theirs lives here.
 *
 * WHY THIS IS A FACTORY AND THE OTHER SIX MODULES ARE FILES. Every other provider differs in something real: a
 * runtime to spawn, a login handshake, a quota surface, a pack to bake. Two keyed providers differ in two URLs
 * and a seed list, and both of those are already on the spec row. One provider module per keyed provider,
 * identical but for those, would be a copy waiting to be edited on one side only, which is the failure the
 * registry above this exists to prevent — so the registry gets a mapped list rather than hand-written entries,
 * and a third keyed provider is a spec row and a seed. */

/* THE COMPILE-TIME MODEL FLOOR PER PROVIDER, and the one per-provider fact that is NOT on the spec row.
 *
 * It belongs to the daemon because it is an answer about this daemon's catalog ladder — what to show before the
 * vendor has been asked, and what to fall back to when it cannot be reached — rather than a fact about the
 * provider that the browser or the contract has any use for. The web has no static floor for these providers at
 * all (modelsFor returns nothing for them), by the same reasoning that leaves Codex and Grok empty there: the
 * daemon's catalog is one route away and is never empty.
 *
 * `Record<KeyProvider, …>` rather than a list, so a keyed provider added to the spec table without a floor is a
 * compile error rather than a picker that opens blank on a fresh sandbox.
 *
 * Going stale costs nothing: every rung above replaces the whole list, and a pick the live catalog no longer
 * offers is repointed to its default (routedModel, in harness-credentials). */
const SEED_MODELS: Record<KeyProvider, readonly Model[]> = {
    // Muse Spark is a reasoning model and the vendor's own examples default to the newer checkpoint, so it
    // leads. The `-contributor` tier is deliberately absent: it is the same checkpoint at a discount in
    // exchange for training on the prompts, which is a decision a person makes on the vendor's dashboard, not
    // one a picker should make look like a free speed-up. It still appears the moment the live catalog lists it.
    meta: [
        { id: "muse-spark-1.2", label: "Muse Spark 1.2" },
        { id: "muse-spark-1.1", label: "Muse Spark 1.1" },
    ],
    // The GLM Coding Plan's own line. 5.3 is what a fresh plan defaults to; 4.7 is what a key that predates it
    // still reaches, and listing it means a plan on the older entitlement is not looking at one unusable row.
    zai: [
        { id: "glm-5.3", label: "GLM-5.3" },
        { id: "glm-4.7", label: "GLM-4.7" },
    ],
};

// One provider's slice of the daemon: its account store and its catalog, held together because the catalog
// reads the store's key and the two must be the same instance (a catalog pointed at a second store would keep
// serving models for an account that has just been disconnected).
export interface KeyedProviderSlice {
    readonly store: KeyedStore;
    readonly catalog: KeyedCatalog;
}

// Every keyed provider's slice, complete over KEY_PROVIDERS by construction.
export type KeyedSlices = Record<KeyProvider, KeyedProviderSlice>;

export interface KeyedSlice {
    readonly keyed: KeyedSlices;
}

export const createKeyedSlice = (input: { readonly authRoot: string; readonly logger: Logger }): KeyedSlice => {
    const slices = KEY_PROVIDERS.map((provider) => {
        const dir = join(input.authRoot, provider);
        const store = fileKeyedStore({
            dir,
            provider,
            providerName: providerSpec(provider)?.label ?? provider,
            logger: input.logger,
        });
        const catalog = createKeyedCatalog({
            provider,
            store,
            seed: SEED_MODELS[provider],
            // Beside the credentials rather than in a cache dir: the list is this account's, and an auth
            // directory that is removed when a provider is disconnected should take its catalog with it.
            file: jsonFile<Model[]>(join(dir, "models.json"), {
                parse: (raw) => z.array(ModelSchema).safeParse(raw).data,
                fallback: () => [],
            }),
        });
        return [provider, { store, catalog }] as const;
    });
    return { keyed: Object.fromEntries(slices) as KeyedSlices };
};

// The seed floor a provider falls back to, for the test that asserts every keyed provider has one that its own
// ordering rule would actually seat first.
export const seedModelsOf = (provider: KeyProvider): readonly Model[] => SEED_MODELS[provider];

/* One provider's module. No adapter (see the header), no boot (nothing to start: the key is read when a turn
 * or a catalog asks), no pack (these providers add nothing to the image, the whole point of speaking the
 * harness's own wire). What is left is exactly what every provider owes: a catalog, a readiness rung, and its
 * rows in the secrets inventory. */
export const keyedProviderModule = (provider: KeyProvider): ProviderModule => ({
    id: provider,
    adapters: [],
    catalog: (services) => services.keyed[provider].catalog.models(),
    // A stored key is the whole of it. Cheap by the seam's contract: one directory listing, never a probe that
    // spends a call against the user's metered account to find out whether their key still works.
    ready: async (services) => (await services.keyed[provider].store.list()).length > 0,
    secretEntries: async (services) =>
        (await services.keyed[provider].store.list()).map((account) =>
            providerAccountEntry(provider, providerSpec(provider)?.label ?? provider, account.id, account.label, authStateRelPath(provider)),
        ),
});

// Every keyed provider's module, in spec order. What the registry appends, so the registry's list of imports
// stays one line however many of these there are.
export const KEYED_PROVIDER_MODULES: readonly ProviderModule[] = KEY_PROVIDERS.map(keyedProviderModule);
