import { z } from "zod";
import { signedPayloads } from "../../auth/signed-payload.js";
import { loadOrMintKey } from "../../store/plain-files/minted-key.js";

// What a gateway URL carries: which provider the requests behind it are for (the trust decision), where they go next,
// and whose conversation they belong to (the log). Signed rather than looked up, so a runtime spawned before a daemon
// restart keeps working after it, and so the upstream can't be chosen by whoever holds a URL: without the signature the
// gateway would forward to any address it was handed.

export interface GatewaySession {
    readonly provider: string;
    readonly upstream: string;
    readonly conversationId?: string | undefined;
}

// An address minted while tool-result clearing ran (to 2026-10-12) also carries `k`; it parses and is ignored.
const PayloadSchema = z.object({ p: z.string().min(1), u: z.string().url(), c: z.string().optional() });

export interface SessionTokens {
    readonly sign: (session: GatewaySession) => Promise<string>;
    readonly verify: (token: string) => Promise<GatewaySession | undefined>;
}

// The signing key, created once and kept beside the vault: a key that changed on every boot would strand every runtime
// still holding an old URL.
export const sessionTokens = (keyPath: string): SessionTokens => sessionTokensFrom(() => loadOrMintKey(keyPath));

// Over any source of the key, read once and kept; a source that fails is asked again next time. Signed with no domain:
// the addresses already handed out were signed over the bare payload (signed-payload.ts).
export const sessionTokensFrom = (readKey: () => Promise<Buffer>): SessionTokens => {
    const payloads = signedPayloads(readKey, PayloadSchema);
    return {
        sign: ({ provider, upstream, conversationId }) =>
            payloads.sign({ p: provider, u: upstream, ...(conversationId !== undefined ? { c: conversationId } : {}) }),
        verify: async (token) => {
            const wire = await payloads.verify(token);
            return wire === undefined ? undefined : { provider: wire.p, upstream: wire.u, conversationId: wire.c };
        },
    };
};
