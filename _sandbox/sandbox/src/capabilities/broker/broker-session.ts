import { createHmac } from "node:crypto";
import { z } from "zod";
import { signedPayloads } from "../../auth/signed-payload.js";
import { loadOrMintKey } from "../../store/plain-files/minted-key.js";

// What a gateway address carries: which card's credential, which of its upstreams, and whose conversation. Signed rather
// than looked up, so a pane or background job started before a daemon restart keeps working after it, and so nobody
// holding an address can point it anywhere else: the upstream is in the signed part, and the gateway still checks it
// against the card's live declaration on every request.

export interface BrokerSession {
    // The capability id whose credential the gateway attaches.
    readonly capability: string;
    // Which of the card's routes: its position in the declaration, since two routes may share an upstream and differ
    // only in how the credential rides (an API's header beside git's Basic).
    readonly route: number;
    // The route's expanded upstream, exactly as brokerRoutes produced it (`URL.href`): a settings change that moves it
    // retires every address minted before.
    readonly upstream: string;
    // The conversation the address was minted for: whose gates, cards and ledger rows its requests answer to.
    readonly conversationId?: string | undefined;
}

const PayloadSchema = z.object({ i: z.string().min(1), r: z.number().int().nonnegative(), u: z.string().url(), c: z.string().min(1).optional() });

export interface BrokerSessions {
    readonly sign: (session: BrokerSession) => Promise<string>;
    readonly verify: (token: string) => Promise<BrokerSession | undefined>;
    // A short tag over `purpose` under the same key: what makes a name nobody can guess without it, such as a
    // conversation's ssh agent socket (ssh-agent-sockets.ts). Never the same as a signature, whatever `purpose` is.
    readonly tag: (purpose: string) => Promise<string>;
}

const TAG_CHARS = 12;

// Created once and kept beside the vault, root-only: a key that changed on every boot would strand every process still
// holding an address, and one an agent could read would let it mint addresses for conversations not its own.
export const brokerSessions = (keyPath: string): BrokerSessions => brokerSessionsFrom(() => loadOrMintKey(keyPath));

// Over any source of the key, read once and kept; a source that fails is asked again next time. Signed as `broker:`, so
// no other token under the same key passes as an address, and a tag (`tag:`) is never a signature.
export const brokerSessionsFrom = (readKey: () => Promise<Buffer>): BrokerSessions => {
    const payloads = signedPayloads(readKey, PayloadSchema, { domain: "broker:" });
    return {
        tag: async (purpose) =>
            createHmac("sha256", await payloads.key())
                .update(`tag:${purpose}`)
                .digest("base64url")
                .slice(0, TAG_CHARS),
        sign: ({ capability, route, upstream, conversationId }) =>
            payloads.sign({ i: capability, r: route, u: upstream, ...(conversationId !== undefined ? { c: conversationId } : {}) }),
        verify: async (token) => {
            const wire = await payloads.verify(token);
            return wire === undefined ? undefined : { capability: wire.i, route: wire.r, upstream: wire.u, conversationId: wire.c };
        },
    };
};
