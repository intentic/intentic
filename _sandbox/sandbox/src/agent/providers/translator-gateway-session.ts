import { z } from "zod";
import { type KeyedProvider, KeyedProviderSchema } from "@intentic/sandbox-contract/schemas/providers/provider-subscriptions";
import { signedPayloads } from "../../auth/signed-payload.js";
import { loadOrMintKey } from "../../store/plain-files/minted-key.js";

// What a translator gateway address carries: the provider whose subscriptions the requests behind it spend. Signed under
// a key of the gateway's own, because the daemon's HTTP server is what the sandbox's public address reaches, and the
// translator's bearer is a constant every image bakes in: an address nobody can mint without the key is what keeps a
// stranger holding that constant from spending the owner's accounts. Signed rather than looked up, so a loop spawned
// before a daemon restart keeps working after it. A provider the translator does not hold subscriptions for never
// verifies: there is nothing behind the gateway to send it to.

const PayloadSchema = z.object({ p: KeyedProviderSchema });

// Prepended to what the signature reads, so no other token signed under this key could ever pass as a gateway address.
const DOMAIN = "translator-gateway:";

export interface TranslatorGatewaySessions {
    readonly sign: (provider: KeyedProvider) => Promise<string>;
    readonly verify: (token: string) => Promise<KeyedProvider | undefined>;
}

// Over any source of the key, read once and kept; a source that fails is asked again next time.
export const translatorGatewaySessionsFrom = (readKey: () => Promise<Buffer>): TranslatorGatewaySessions => {
    const payloads = signedPayloads(readKey, PayloadSchema, { domain: DOMAIN });
    return {
        sign: (provider) => payloads.sign({ p: provider }),
        verify: async (token) => (await payloads.verify(token))?.p,
    };
};

// The key, created once and kept outside the agent's reach beside the privacy gateway's: a key that changed on every
// boot would strand every loop still holding an old address.
export const translatorGatewaySessions = (keyPath: string): TranslatorGatewaySessions => translatorGatewaySessionsFrom(() => loadOrMintKey(keyPath));
