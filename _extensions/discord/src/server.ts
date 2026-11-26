import { declaredMessageLimit } from "@intentic/connector-runtime";
import type { ExtensionServerApi, ServerActivation } from "@intentic/extension-api/runtime";
import { listenerRouteUrl, ListenerStateSchema } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import { type Fetch, publishPost } from "./publish.js";

// The Discord card's backend (2026-11-26): it publishes the posts the owner approved for Discord (`api.approvals.publish`),
// which the daemon used to post itself through the gateway. The bots' tokens are read from the daemon's feed for this
// extension's own listener (`/listeners/discord/state`, which it reaches as the listener's owner and which hands it only
// the cards it contributes), at the moment of posting, so a token changed on the card is the one used.

// The connected cards' bot tokens, in card order, each once.
const botTokens = async (api: ExtensionServerApi): Promise<readonly string[]> => {
    const answered = await api.daemon.request(listenerRouteUrl("state", "discord"));
    if (!answered.ok) {
        throw new Error(`the daemon answered ${answered.status} for the Discord cards`);
    }
    const { connectors } = ListenerStateSchema.parse(await answered.json());
    return [...new Set(connectors.map(({ config }) => String(config["botToken"] ?? "")).filter((token) => token !== ""))];
};

export interface BackendOptions {
    // How a request reaches Discord; the real `fetch` unless a suite stands in for it.
    readonly fetch?: Fetch;
    readonly sleep?: (ms: number) => Promise<void>;
}

/** The backend's activation, with the seams a suite stands in for. */
export const discordBackend =
    (options: BackendOptions = {}) =>
    (api: ExtensionServerApi): ServerActivation => {
        const limit = declaredMessageLimit(new URL("../intentic-extension.json", import.meta.url), "discord");
        api.approvals.publish((post, { signal }) => publishPost({ tokens: () => botTokens(api), limit, ...options }, post, signal));
        return { deactivate: () => undefined };
    };

export const activateServer = discordBackend();
