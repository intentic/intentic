import type { Logger } from "pino";
import { type ProviderModule, translatorAccountEntries, translatorReady } from "../../agent/providers/provider-module.js";
import type { CliProxyClient } from "../../agent/providers/translator.js";
import type { Services } from "../../composition.js";
import type { AcpConnections } from "../acp/acp-connection.js";
import { KIMI_CLI } from "../kimi-cli/kimi-cli.js";
import { type CliDoorDeps, cliAccountDoor } from "../vendor-cli/vendor-cli-door.js";
import { type CliParts, cliPacks, cliReady, cliSecretEntries, createCliParts } from "../vendor-cli/vendor-cli-slice.js";
import { cliAdapter, type CliTurnDeps } from "../vendor-cli/vendor-cli-turn.js";
import { createKimiCatalog, type KimiCatalog } from "./kimi-catalog.js";

// Kimi Code on two loops. Under Claude Code (the default) its credential is the translator's subscription OAuth and its
// catalog the translator's. On its own loop (`vendor`) it is Moonshot's Kimi Code CLI (runtimes/kimi-cli), signed in
// with the CLI's own device login, one CLI home per account: a separate connection from the translator's, which the
// account door holds and the connect card files under the CLI's loop.

export interface KimiSlice {
    // Kimi's model catalog: the translator's provider-scoped definitions, read through the management API.
    readonly kimiModels: KimiCatalog;
    // The Kimi CLI's accounts and the models the first one offers, for its own loop.
    readonly kimiCli: CliParts;
}

export const createKimiSlice = (input: {
    readonly cliProxy: CliProxyClient;
    readonly authRoot: string;
    readonly logger: Logger;
    readonly acpConnections: () => AcpConnections;
}): KimiSlice => ({
    kimiModels: createKimiCatalog(input.cliProxy),
    kimiCli: createCliParts(KIMI_CLI, input),
});

export type KimiCliAdapterDeps = CliTurnDeps & Pick<Services, "kimiCli">;

const KIMI_CLI_ADAPTER = cliAdapter<"kimi-cli", KimiCliAdapterDeps>({ ...KIMI_CLI, runtime: "kimi-cli" }, (services) => services.kimiCli);

// What the Kimi module reads: both catalogs, whether a translator is there to serve it, and the CLI door's seams.
export type KimiProviderDeps = KimiCliAdapterDeps & CliDoorDeps & Pick<Services, "config" | "kimiModels">;

export const kimiProvider: ProviderModule<KimiProviderDeps> = {
    id: "kimi",
    adapters: [KIMI_CLI_ADAPTER],
    // The account door is the CLI's: the translator's subscriptions have a door of their own (/translator).
    accounts: (services) => cliAccountDoor(KIMI_CLI, services.kimiCli.store, services.kimiCli.models, services),
    catalog: (services) => services.kimiModels.models(),
    // Either credential can serve some loop of Kimi's.
    ready: async (services, shared) => (await translatorReady("kimi")(services, shared)) || (await cliReady(services.kimiCli)),
    // The CLI is a pack an account on disk asks the owner's rebuild to bake.
    packs: (services) => cliPacks(KIMI_CLI, services.authRoot),
    secretEntries: async (services, shared) => [
        ...(await translatorAccountEntries("kimi", "Kimi Code")(services, shared)),
        ...(await cliSecretEntries(KIMI_CLI, services.kimiCli)),
    ],
};
