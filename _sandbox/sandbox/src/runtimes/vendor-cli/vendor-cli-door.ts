import { errorMessage } from "@intentic/base/errors";
import type { LoginStatus, OauthAccount } from "@intentic/sandbox-contract/schemas/providers/provider-oauth";
import type { Services } from "../../composition.js";
import { forgetAccountState, sameAccount, signInIdentity } from "../../agent/providers/accounts/account-identity.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { opt } from "../../opt.js";
import { type CliStore, cliAccountRow, cliStoreDir } from "./vendor-cli-store.js";
import { cliLoginOpen, releaseCliLogin, startCliLogin } from "./vendor-cli-login.js";
import { cliAgentId, type CliIdentity, ensureCli, type VendorCli } from "./vendor-cli.js";

// A vendor CLI's account door (agent/provider-module.ts): start installs the CLI if this sandbox has none yet (the
// sign-in is the CLI's own), runs its device login into a fresh home, and answers with the page and code; the CLI polls
// the vendor itself, and once it exits signed in the home becomes the account's. No paste comes back, so there is no
// `complete`: the card watches the account list, and `status` says how an attempt ended. Neither vendor publishes an
// allowance a CLI token can read, so a row carries no usage.

// How long an attempt's outcome stays readable once it ended, for a card polling it to learn how it ended.
const OUTCOME_KEPT_MS = 15 * 60_000;

export type CliDoorDeps = Pick<Services, "acpConnections" | "composeEnvironment" | "headroom" | "observedLimits" | "providerRefusals" | "authRoot">;

// The account's model list, dropped when the first account changes: the first account decides it.
export interface CliModelsCache {
    readonly forget: () => void;
}

export const cliAccountDoor = (cli: VendorCli, store: CliStore, models: CliModelsCache, services: CliDoorDeps): AccountDoor => {
    const outcomes = new Map<string, { readonly status: LoginStatus; readonly at: number }>();
    const settled = (handshake: string, status: LoginStatus): void => {
        const now = Date.now();
        for (const [id, outcome] of outcomes) {
            if (now - outcome.at > OUTCOME_KEPT_MS) {
                outcomes.delete(id);
            }
        }
        outcomes.set(handshake, { status, at: now });
    };
    // Who signed in, best effort: a home the CLI wrote in a shape this build does not read is a nameless row, not a failure.
    const identityOf = async (home: string): Promise<CliIdentity> => {
        try {
            return await cli.identity(home);
        } catch (error) {
            store.logger.warn({ err: error, provider: cli.provider }, `${cli.runtime}: could not read who signed in`);
            return {};
        }
    };
    // The one connect rule (account-identity.ts): the same person signing in again lands on their account's id and keeps
    // its name and place, so every conversation pinned to it carries on; anyone else is new.
    const adopt = async (handshake: string, home: string): Promise<OauthAccount> => {
        const { email } = await identityOf(home);
        const match = sameAccount(await store.list(), { ...opt("email", email), variant: cli.door });
        const kept = match === undefined ? undefined : await store.read(match.id);
        const id = kept?.id ?? handshake;
        // A process still running on the old sign-in would keep spending it; the next turn starts one on the new home.
        services.acpConnections.drop(cliAgentId(cli, id));
        await store.adopt(id, home);
        const stored = { id, ...opt("label", kept?.label), ...opt("email", email), connectedAt: kept?.connectedAt ?? Date.now() };
        await store.write(stored);
        models.forget();
        await services.composeEnvironment();
        store.logger.info({ provider: cli.provider, account: id, reconnected: kept !== undefined }, `${cli.runtime}: account connected`);
        return cliAccountRow(cli, stored);
    };
    return {
        start: async () => {
            const binary = await ensureCli(cli);
            const started = await startCliLogin(cli, binary, cliStoreDir(services.authRoot, cli));
            const { handshake } = started;
            // Nobody is looking at the attempt as it ends, so its ending lands on `status`, where the card reads it.
            void (async () => {
                try {
                    settled(handshake, { status: "ok", account: await adopt(handshake, await started.signedIn) });
                } catch (error) {
                    settled(handshake, { status: "error", error: errorMessage(error) || `${cli.name} did not finish signing in.` });
                } finally {
                    await releaseCliLogin(handshake);
                }
            })();
            return { url: started.url, code: started.code, state: "", flow: "device", variant: cli.door, handshake, expiresAt: started.expiresAt };
        },
        status: (handshake) => {
            const outcome = outcomes.get(handshake);
            if (outcome !== undefined) {
                return outcome.status;
            }
            return cliLoginOpen(handshake)
                ? { status: "wait" }
                : { status: "error", error: "That sign-in has expired or was never started here: start it again." };
        },
        cancel: (handshake) => {
            void releaseCliLogin(handshake);
        },
        list: async () => store.list(),
        rename: async (id, label) => {
            const stored = await store.read(id);
            if (stored === undefined) {
                return undefined;
            }
            const typed = label.trim();
            // A blank label clears the override, so the row falls back to the identity the sign-in named.
            const renamed = typed === "" ? { ...stored, label: undefined } : { ...stored, label: typed };
            await store.write(renamed);
            return cliAccountRow(cli, renamed);
        },
        identityOf: signInIdentity,
        // Ends the account's warm process (it holds the home), clears the home with its tokens and everything read about the
        // account, and recomposes, so the pack leaves the overlay with the last account.
        forget: async (id) => {
            services.acpConnections.drop(cliAgentId(cli, id));
            await Promise.all([store.clear(id), forgetAccountState(services, cli.provider, id)]);
            models.forget();
            await services.composeEnvironment();
        },
    };
};
