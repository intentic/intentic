import type { errorMessage } from "@intentic/base/errors";
import type { MintedProvider } from "@intentic/sandbox-contract/models/provider-specs";
import type { Services } from "../../composition.js";
import { forgetAccountState, signInIdentity } from "../../agent/providers/accounts/account-identity.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { cancelMintedLogin, cancelMintedLoginsFor, completeMintedLogin, mintedLoginStatus, startMintedLogin } from "./minted-login.js";
import { ensureMuseCli } from "../muse/muse-cli.js";

// Whatever an install threw, as errorMessage reads it.
type Thrown = Parameters<typeof errorMessage>[0];

// What a fresh account brings down with it: a Meta key is a Muse Code key, so Meta's own loop's program is fetched as the
// account lands rather than on its first turn. Best-effort: a turn installs it on demand anyway (muse-adapter.ts).
const fetchLoopProgram = (provider: MintedProvider, logger: Services["logger"]): void => {
    if (provider !== "meta") {
        return;
    }
    ensureMuseCli().catch((error: Thrown) => logger.warn({ err: error, provider }, "minted: the Muse Code CLI could not be installed"));
};

// A minted provider's account door (agent/provider-module.ts): sign-in ends with the daemon minting the vendor's own
// key, by device poll (Meta) or address-bar redirect (Z.ai). The catalog is forgotten on every write, since it's cached
// per connected account's key for a minute: without it, a disconnected account would keep offering its old model list,
// and a turn could resolve against it, for the rest of the TTL.
export const mintedAccountDoor =
    (provider: MintedProvider) =>
    (
        services: Pick<Services, "minted" | "logger" | "headroom" | "observedLimits" | "providerRefusals" | "hostHub" | "webextHub">,
    ): AccountDoor => {
        const slice = services.minted[provider];
        return {
            start: (variant) =>
                startMintedLogin({
                    provider,
                    ...(variant === undefined ? {} : { variant }),
                    driver: slice.login,
                    store: slice.store,
                    logger: services.logger,
                    onConnected: () => {
                        slice.catalog.forget();
                        fetchLoopProgram(provider, services.logger);
                    },
                    bridge: services,
                }),
            // Only the redirect shape brings anything back; the mint that follows lands as a row in the list on its
            // own.
            complete: async ({ handshake, redirectUrl }) => {
                if (redirectUrl === undefined || redirectUrl.trim() === "") {
                    throw new Error("Paste the whole address the sign-in landed on.");
                }
                completeMintedLogin({ provider, handshake, redirectUrl });
                return undefined;
            },
            status: (handshake) => mintedLoginStatus(provider, handshake),
            cancel: (handshake) => cancelMintedLogin(provider, handshake),
            list: () => slice.store.list(),
            rename: (id, label) => slice.store.rename(id, label),
            identityOf: signInIdentity,
            // A sign-in still in flight dies with the disconnect, or its poll would land a fresh credential into a
            // store the user just cleared minutes later (same reasoning as the translator's codex disconnect).
            forget: async (id) => {
                cancelMintedLoginsFor(provider);
                await Promise.all([slice.store.disconnect(id), forgetAccountState(services, provider, id)]);
                slice.catalog.forget();
            },
        };
    };
