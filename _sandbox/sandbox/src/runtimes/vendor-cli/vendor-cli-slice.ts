import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import { authStateRelPath, providerAccountEntry } from "../../agent/providers/provider-module.js";
import type { AcpConnections } from "../acp/acp-connection.js";
import { type CliCatalog, createCliCatalog } from "./vendor-cli-catalog.js";
import { type CliStore, cliStoreDir, fileCliStore, liveCliAccounts, readCliAccounts } from "./vendor-cli-store.js";
import type { VendorCli } from "./vendor-cli.js";

// What a provider module holds for its CLI loop, built once at composition: the account store and the model catalog,
// and the module-facing answers read from them (readiness, packs, secrets rows).

export interface CliParts {
    readonly store: CliStore;
    readonly models: CliCatalog;
}

export const createCliParts = (
    cli: VendorCli,
    input: { readonly authRoot: string; readonly logger: Logger; readonly acpConnections: () => AcpConnections },
): CliParts => {
    const dir = cliStoreDir(input.authRoot, cli);
    const store = fileCliStore(dir, cli, input.logger);
    return {
        store,
        models: createCliCatalog({
            cli,
            store,
            connections: input.acpConnections,
            persistPath: join(dir, "models.json"),
            probeDir: join(tmpdir(), `intentic-${cli.runtime}-probe`),
        }),
    };
};

// Whether a turn on the CLI's loop could be served from what is on disk: a sign-in it has not refused.
export const cliReady = async (parts: Pick<CliParts, "store">): Promise<boolean> => (await liveCliAccounts(parts.store)).length > 0;

// The pack an account on disk asks the owner's next rebuild to bake; read from the file-backed store, never a probe.
export const cliPacks = async (cli: VendorCli, authRoot: string): Promise<readonly string[]> =>
    (await readCliAccounts(cliStoreDir(authRoot, cli))).length > 0 ? [cli.engine] : [];

// One secrets-inventory row per account, filed under the provider and named for the program.
export const cliSecretEntries = async (cli: VendorCli, parts: Pick<CliParts, "store">) =>
    (await parts.store.list()).map((account) =>
        providerAccountEntry(cli.provider, cli.name, account.id, account.label, authStateRelPath(cli.authDir, `${account.id}.json`)),
    );
