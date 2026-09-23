import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../../agent/providers/provider-module.js";
import type { CliProxyClient } from "../../agent/providers/translator.js";
import type { Services } from "../../composition.js";
import { createKimiCatalog, type KimiCatalog } from "./kimi-catalog.js";

/* Kimi has no native adapter; this module exposes only its provider catalog. */

export interface KimiSlice {
    // Kimi's model catalog: the translator's provider-scoped definitions, read through the management API.
    readonly kimiModels: KimiCatalog;
}

export const createKimiSlice = (cliProxy: CliProxyClient): KimiSlice => ({
    kimiModels: createKimiCatalog(cliProxy),
});

// What the Kimi module reads: its catalog, and whether a translator is there to serve it at all.
export type KimiProviderDeps = Pick<Services, "config" | "kimiModels">;

export const kimiProvider: ProviderModule<KimiProviderDeps> = {
    id: "kimi",
    adapters: [],
    catalog: (services) => services.kimiModels.models(),
    ready: async (services, shared) => services.config.translator.url !== "" && (await shared.translatorAccounts()).kimi.length > 0,
    secretEntries: async (_services, shared) =>
        (await shared.translatorAccounts()).kimi.map((account) =>
            providerAccountEntry("kimi", "Kimi Code", account.name, account.label, authStateRelPath("cliproxy")),
        ),
};
