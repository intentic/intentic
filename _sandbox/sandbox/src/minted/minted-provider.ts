import { join } from "node:path";
import {
    MINTED_PROVIDERS,
    type MintedProvider,
    type Model,
    ModelSchema,
    mintedVariants,
    providerSpec,
} from "@intentic/sandbox-contract";
import type { Logger } from "pino";
import { z } from "zod";
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../agent/provider-module.js";
import { jsonFile } from "../store/json-file.js";
import { metaLoginDriver } from "./meta-login.js";
import { createMintedCatalog, type MintedCatalog } from "./minted-catalog.js";
import { fileMintedStore, type MintedStore } from "./minted-credentials.js";
import type { MintedLoginDriver } from "./minted-login.js";
import { zaiLoginDriver } from "./zai-login.js";

/* EVERYTHING A MINTED PROVIDER CONTRIBUTES TO THE DAEMON, written ONCE and instantiated per provider.
 *
 * These are the Kimi shape — no adapter, because they have no native runtime and `capabilitiesOf` hands both
 * their harnesses to the Claude Code loop, which the claude module contributes — with the one addition Kimi
 * does not need: a credential of their own, because nothing else in this daemon holds it. Kimi's subscription
 * lives in the translator; theirs is a key their own sign-in minted, and it lives here.
 *
 * WHY THIS IS A FACTORY AND THE OTHER SIX MODULES ARE FILES. Every other provider differs in something real: a
 * runtime to spawn, a login handshake, a quota surface, a pack to bake. Two minted providers differ in a seed
 * list, a login driver and their estates' URLs, and all but the driver are already on the spec row. One provider
 * module per minted provider, identical but for those, would be a copy waiting to be edited on one side only,
 * which is the failure the registry above this exists to prevent — so the registry gets a mapped list rather
 * than hand-written entries, and a third minted provider is a spec row, a seed and a driver. */

/* THE COMPILE-TIME MODEL FLOOR PER PROVIDER, and the one per-provider fact that is NOT on the spec row.
 *
 * It belongs to the daemon because it is an answer about this daemon's catalog ladder — what to show before the
 * vendor has been asked, and what to fall back to when it cannot be reached — rather than a fact about the
 * provider that the browser or the contract has any use for. The web has no static floor for these providers at
 * all (modelsFor returns nothing for them), by the same reasoning that leaves Codex and Grok empty there: the
 * daemon's catalog is one route away and is never empty.
 *
 * `Record<MintedProvider, …>` rather than a list, so a minted provider added to the spec table without a floor
 * is a compile error rather than a picker that opens blank on a fresh sandbox.
 *
 * ONE FLOOR PER PROVIDER, NOT PER ESTATE, because the estates sell the same model line: what differs between
 * api.z.ai and open.bigmodel.cn is who may call them, not what they serve. The live read replaces it either way.
 *
 * Going stale costs nothing: every rung above replaces the whole list, and a pick the live catalog no longer
 * offers is repointed to its default (routedModel, in harness-credentials). */
const SEED_MODELS: Record<MintedProvider, readonly Model[]> = {
    // Muse Spark is a reasoning model and the vendor's own examples default to the newer checkpoint, so it
    // leads. The `-contributor` tier is deliberately absent: it is the same checkpoint at a discount in
    // exchange for training on the prompts, which is a decision a person makes on the vendor's dashboard, not
    // one a picker should make look like a free speed-up. It still appears the moment the live catalog lists it.
    meta: [
        { id: "muse-spark-1.2", label: "Muse Spark 1.2" },
        { id: "muse-spark-1.1", label: "Muse Spark 1.1" },
    ],
    // The GLM Coding Plan's own line. 5.3 is what a fresh plan defaults to; 4.7 is what a plan on the older
    // entitlement still reaches, and listing it means such a plan is not looking at one unusable row.
    zai: [
        { id: "glm-5.3", label: "GLM-5.3" },
        { id: "glm-4.7", label: "GLM-4.7" },
    ],
};

/* WHICH SIGN-IN EACH PROVIDER RUNS. The one genuinely per-provider piece of code left, and a `Record` rather
 * than a lookup with a fallback: a minted provider without a driver would otherwise be a Connect button that
 * throws when pressed, discovered by a user rather than by the compiler. */
const LOGIN_DRIVERS: Record<MintedProvider, MintedLoginDriver> = {
    meta: metaLoginDriver(),
    zai: zaiLoginDriver(),
};

// One provider's slice of the daemon: its account store, one catalog per estate, and its sign-in. Held together
// because the catalogs read the store's credentials and the two must be the same instance (a catalog pointed at
// a second store would keep serving models for an account that has just been disconnected).
export interface MintedProviderSlice {
    readonly store: MintedStore;
    readonly login: MintedLoginDriver;
    /* THE CATALOG A TURN ON A GIVEN ACCOUNT MUST USE, by estate. Not one per provider: a key minted on
     * open.bigmodel.cn cannot read api.z.ai's model list, so a shared cache would serve one estate's rows to the
     * other and every turn on a row it offered would be refused by a host that never had that model. */
    readonly catalogOf: (variant: string) => MintedCatalog;
    // The provider-level catalog the picker and the readiness sweep read: the estate of the first connected
    // account, because that is the account a turn defaults to.
    readonly catalog: MintedCatalog;
}

// Every minted provider's slice, complete over MINTED_PROVIDERS by construction.
export type MintedSlices = Record<MintedProvider, MintedProviderSlice>;

export interface MintedSlice {
    readonly minted: MintedSlices;
}

export const createMintedSlice = (input: { readonly authRoot: string; readonly logger: Logger }): MintedSlice => {
    const slices = MINTED_PROVIDERS.map((provider) => {
        const dir = join(input.authRoot, provider);
        const store = fileMintedStore({
            dir,
            provider,
            providerName: providerSpec(provider)?.label ?? provider,
            logger: input.logger,
        });
        const variants = mintedVariants(provider) ?? [];
        const catalogs = new Map<string, MintedCatalog>(
            variants.map((variant) => [
                variant.id,
                createMintedCatalog({
                    provider,
                    variant,
                    store,
                    seed: SEED_MODELS[provider],
                    // Beside the credentials rather than in a cache dir: the list is this estate's, and an auth
                    // directory that is removed when a provider is disconnected should take its catalogs with it.
                    file: jsonFile<Model[]>(join(dir, `models-${variant.id}.json`), {
                        parse: (raw) => z.array(ModelSchema).safeParse(raw).data,
                        fallback: () => [],
                    }),
                }),
            ]),
        );
        // The default estate's catalog, which is what an unconnected provider's picker row shows: its seed,
        // under a badge saying what connecting would cost.
        const fallback = catalogs.get(variants[0]?.id ?? "");
        if (fallback === undefined) {
            // Unreachable while the contract's own test holds (every minted row has at least one estate), and
            // cheaper to state than to thread an optional catalog through every reader.
            throw new Error(`${provider} has no sign-in estates on its spec row`);
        }
        const catalogOf = (variant: string): MintedCatalog => catalogs.get(variant) ?? fallback;
        const slice: MintedProviderSlice = {
            store,
            login: LOGIN_DRIVERS[provider],
            catalogOf,
            catalog: {
                // Read per call, never captured: which estate answers for the provider changes the moment an
                // account is connected or dropped, and this is the read the picker makes on every open.
                models: async () => {
                    const first = (await store.credentials())[0];
                    return await (first === undefined ? fallback : catalogOf(first.variant)).models();
                },
                // Every estate forgets together. A connect or a disconnect changes which account is first, so
                // forgetting only the estate that changed would leave the provider-level answer stale.
                forget: () => {
                    for (const catalog of catalogs.values()) {
                        catalog.forget();
                    }
                },
            },
        };
        return [provider, slice] as const;
    });
    return { minted: Object.fromEntries(slices) as MintedSlices };
};

// The seed floor a provider falls back to, for the test that asserts every minted provider has one that its own
// ordering rule would actually seat first.
export const seedModelsOf = (provider: MintedProvider): readonly Model[] => SEED_MODELS[provider];

/* One provider's module. No adapter (see the header), no boot (nothing to start: the credential is read when a
 * turn or a catalog asks), no pack (these providers add nothing to the image, the whole point of speaking the
 * harness's own wire). What is left is exactly what every provider owes: a catalog, a readiness rung, and its
 * rows in the secrets inventory. */
export const mintedProviderModule = (provider: MintedProvider): ProviderModule => ({
    id: provider,
    adapters: [],
    catalog: (services) => services.minted[provider].catalog.models(),
    // A stored credential is the whole of it. Cheap by the seam's contract: one directory listing, never a probe
    // that spends a call against the user's plan to find out whether their key still works.
    ready: async (services) => (await services.minted[provider].store.list()).length > 0,
    secretEntries: async (services) =>
        (await services.minted[provider].store.list()).map((account) =>
            providerAccountEntry(provider, providerSpec(provider)?.label ?? provider, account.id, account.label, authStateRelPath(provider)),
        ),
});

// Every minted provider's module, in spec order. What the registry appends, so the registry's list of imports
// stays one line however many of these there are.
export const MINTED_PROVIDER_MODULES: readonly ProviderModule[] = MINTED_PROVIDERS.map(mintedProviderModule);
