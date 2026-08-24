import { authStateRelPath, type ProviderModule, providerAccountEntry } from "../agent/provider-module.js";
import type { CliProxyClient } from "../agent/translator.js";
import { createKimiCatalog, type KimiCatalog } from "./kimi-catalog.js";

/* EVERYTHING KIMI CONTRIBUTES TO THE DAEMON, and it is the module that proves the seam's floor: NO adapter
 * (Kimi has no native runtime — `capabilitiesOf("kimi", …)` answers the Claude Code loop, whose adapter the
 * claude module contributes), no boot, no pack of its own (the translator's rides translatorWanted). What is
 * left is exactly what every provider owes: a catalog, a readiness rung, and its rows in the secrets
 * inventory — the last of which was MISSING for as long as that list was hand-enumerated, which is the
 * omission this module structure exists to make impossible. */

export interface KimiSlice {
    // Kimi's model catalog: the translator's provider-scoped definitions, read through the management API.
    readonly kimiModels: KimiCatalog;
}

export const createKimiSlice = (cliProxy: CliProxyClient): KimiSlice => ({
    kimiModels: createKimiCatalog(cliProxy),
});

export const kimiProvider: ProviderModule = {
    id: "kimi",
    adapters: [],
    catalog: (services) => services.kimiModels.models(),
    ready: async (services, shared) => services.config.translator.url !== "" && (await shared.translatorAccounts()).kimi.length > 0,
    secretEntries: async (_services, shared) =>
        (await shared.translatorAccounts()).kimi.map((account) =>
            providerAccountEntry("kimi", "Kimi Code", account.name, account.label, authStateRelPath("cliproxy")),
        ),
};
