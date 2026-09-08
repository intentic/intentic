import type { MintedProvider } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { cancelMintedLogin, cancelMintedLoginsFor, completeMintedLogin, startMintedLogin } from "./minted-login.js";

// A minted provider's account door (agent/provider-module.ts): sign-in ends with the daemon minting the vendor's own
// key, by device poll (Meta) or address-bar redirect (Z.ai). The catalog is forgotten on every write, since it's cached
// per connected account's key for a minute: without it, a disconnected account would keep offering its old model list,
// and a turn could resolve against it, for the rest of the TTL.
export const mintedAccountDoor =
    (provider: MintedProvider) =>
    (services: Pick<Services, "minted" | "logger">): AccountDoor => {
        const slice = services.minted[provider];
        return {
            start: (variant) =>
                startMintedLogin({
                    provider,
                    ...(variant === undefined ? {} : { variant }),
                    driver: slice.login,
                    store: slice.store,
                    logger: services.logger,
                    onConnected: () => slice.catalog.forget(),
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
            cancel: (handshake) => cancelMintedLogin(provider, handshake),
            list: () => slice.store.list(),
            rename: (id, label) => slice.store.rename(id, label),
            // A sign-in still in flight dies with the disconnect, or its poll would land a fresh credential into a
            // store the user just cleared minutes later (same reasoning as the translator's codex disconnect).
            disconnect: async (id) => {
                cancelMintedLoginsFor(provider);
                await slice.store.disconnect(id);
                slice.catalog.forget();
            },
        };
    };
