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
import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../../agent/providers/provider-module.js";
import { jsonFile } from "../../store/json-file.js";
import { metaLoginDriver } from "./meta-login.js";
import { createMintedCatalog, type MintedCatalog } from "./minted-catalog.js";
import { fileMintedStore, type MintedStore } from "./minted-credentials.js";
import type { MintedLoginDriver } from "./minted-login.js";
import { zaiLoginDriver } from "./zai-login.js";
import { mintedAccountDoor } from "./minted-accounts.js";

// Everything a minted provider contributes to the daemon, written once and instantiated per provider: the Kimi shape
// (no adapter, both harnesses ride the Claude Code loop) plus a credential of their own, since nothing else holds it. A
// factory rather than one file per provider, since two minted providers differ only in a seed list, a login driver and
// estate URLs; a third costs a spec row, a seed and a driver.

// Compile-time model floor per provider (not per estate, since estates sell the same line), the one per-provider fact
// off the spec row. `Record`, not a list, so a provider added without a floor is a compile error; going stale costs
// nothing since the live read always replaces it.
const SEED_MODELS: Record<MintedProvider, readonly Model[]> = {
    // Newer checkpoint leads, matching the vendor's own default. The `-contributor` tier (same checkpoint, discounted
    // for training on prompts) is absent: that's a dashboard decision, not a picker default.
    meta: [
        { id: "muse-spark-1.2", label: "Muse Spark 1.2" },
        { id: "muse-spark-1.1", label: "Muse Spark 1.1" },
    ],
    // 5.3 is a fresh plan's default; 4.7 is what an older entitlement still reaches, listed so that plan isn't left
    // with one unusable row.
    zai: [
        { id: "glm-5.3", label: "GLM-5.3" },
        { id: "glm-4.7", label: "GLM-4.7" },
    ],
};

// `Record`, not a lookup with a fallback: a provider without a driver would be a Connect button that throws when
// pressed, found by a user instead of the compiler.
const LOGIN_DRIVERS: Record<MintedProvider, MintedLoginDriver> = {
    meta: metaLoginDriver(),
    zai: zaiLoginDriver(),
};

// One provider's slice: its store, per-estate catalogs and sign-in, held together since a catalog must read its own
// store's credentials, not a second instance's.
export interface MintedProviderSlice {
    readonly store: MintedStore;
    readonly login: MintedLoginDriver;
    // The catalog a turn on a given account must use, by estate: a shared cache would serve one estate's rows to the
    // other, and every turn on such a row would be refused by a host that never had that model.
    readonly catalogOf: (variant: string) => MintedCatalog;
    // The provider-level catalog the picker and readiness sweep read: the estate of the first connected account, since
    // that's the account a turn defaults to.
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
                    // Beside the credentials rather than in a cache dir: the list is this estate's, and a disconnected
                    // provider's auth directory should take its catalogs with it.
                    file: jsonFile<Model[]>(join(dir, `models-${variant.id}.json`), {
                        parse: (raw) => z.array(ModelSchema).safeParse(raw).data,
                        fallback: () => [],
                    }),
                }),
            ]),
        );
        // The default estate's catalog, which is what an unconnected provider's picker row shows: its seed, under a
        // badge saying what connecting would cost.
        const fallback = catalogs.get(variants[0]?.id ?? "");
        if (fallback === undefined) {
            // Unreachable while the contract's own test holds (every minted row has at least one estate), and cheaper
            // to state than to thread an optional catalog through every reader.
            throw new Error(`${provider} has no sign-in estates on its spec row`);
        }
        const catalogOf = (variant: string): MintedCatalog => catalogs.get(variant) ?? fallback;
        const slice: MintedProviderSlice = {
            store,
            login: LOGIN_DRIVERS[provider],
            catalogOf,
            catalog: {
                // Read per call, never captured: which estate answers changes the moment an account is connected or
                // dropped.
                models: async () => {
                    const first = (await store.credentials())[0];
                    return await (first === undefined ? fallback : catalogOf(first.variant)).models();
                },
                // Every estate forgets together: a connect or disconnect changes which account is first, so forgetting
                // only the changed estate would leave the provider-level answer stale.
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

// No adapter (see the header), no boot (nothing to start), no pack (these providers add nothing to the image). What's
// left is what every provider owes: a catalog, a readiness rung, and its secrets-inventory rows.
export const mintedProviderModule = (provider: MintedProvider): ProviderModule => ({
    id: provider,
    accounts: mintedAccountDoor(provider),
    adapters: [],
    catalog: (services) => services.minted[provider].catalog.models(),
    // A stored credential is the whole of it: one directory listing, never a probe that spends a call against the
    // user's plan to check if the key still works.
    ready: async (services) => (await services.minted[provider].store.list()).length > 0,
    secretEntries: async (services) =>
        (await services.minted[provider].store.list()).map((account) =>
            providerAccountEntry(provider, providerSpec(provider)?.label ?? provider, account.id, account.label, authStateRelPath(provider)),
        ),
});

// Every minted provider's module, in spec order, so the registry's list of imports stays one line however many of these
// there are.
export const MINTED_PROVIDER_MODULES: readonly ProviderModule[] = MINTED_PROVIDERS.map(mintedProviderModule);
