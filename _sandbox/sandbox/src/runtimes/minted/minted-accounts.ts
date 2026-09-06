import type { MintedProvider } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import type { AccountDoor } from "../../agent/providers/provider-module.js";
import { cancelMintedLogin, cancelMintedLoginsFor, completeMintedLogin, startMintedLogin } from "./minted-login.js";

/* A MINTED PROVIDER'S ACCOUNT DOOR (agent/provider-module.ts): a sign-in that ends with the daemon minting the
 * vendor's own key, by a device poll (Meta) or by a redirect that dead-ends in the user's address bar (Z.ai's
 * mainland estate), and a store of the keys it minted. One door per provider over one slice each.
 *
 * THE CATALOG IS FORGOTTEN ON EVERY WRITE. It is read with a connected account's key and cached for a minute;
 * connecting or disconnecting changes which account that is, or whether there is one at all. Without the forget,
 * a sandbox that just disconnected its only Z.ai plan would keep offering that key's model list — and, worse, a
 * turn resolved against it — for the rest of the TTL. The connect side of that is inside the login (it lands
 * minutes after `start` answered); the disconnect side is here. */
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
            // Only the redirect shape has anything to bring back: the address delivers the grant, and the mint
            // that follows lands as a row in the list, so there is no account to answer with here.
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
            /* A SIGN-IN STILL IN FLIGHT DIES WITH THE DISCONNECT. Its poll would otherwise land a fresh
             * credential into a store the user has just cleared out, minutes after they cleared it — the same
             * reasoning the translator's codex disconnect kills its pending device login for. */
            disconnect: async (id) => {
                cancelMintedLoginsFor(provider);
                await slice.store.disconnect(id);
                slice.catalog.forget();
            },
        };
    };
