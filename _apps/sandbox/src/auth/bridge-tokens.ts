import { randomBytes, randomUUID } from "node:crypto";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { tokenEquals } from "./auth.js";

/* Bridge tokens: the credential the ACP editor bridge (`intentic-acp`, spawned by Zed/JetBrains on the
 * user's machine) presents on every call, via the `x-intentic-bridge` header. The sync pairing precedent
 * (owner mints in the browser, a CLI redeems via header) made durable: PERSISTED (it authenticates every
 * call, not a one-time enrollment — /work/.intentic survives rebuilds with the workspace), HASHED at rest
 * (sha256; the raw `ibt_…` value is returned exactly once at mint), and REVOCABLE per token. The token is
 * deliberately scoped (bridgeScoped below) to the agent-conversation surface — but note honestly: driving
 * the agent means editing files and running commands in the sandbox, so a stolen token ≈ the agent's reach.
 * The mint card states this. */

const StoredTokensSchema = z.object({
    tokens: z.array(z.object({ id: z.string(), label: z.string(), hash: z.string(), createdAt: z.number() })),
});
type StoredTokens = z.infer<typeof StoredTokensSchema>;

export interface BridgeTokenSummary {
    readonly id: string;
    readonly label: string;
    readonly createdAt: number;
}

export interface BridgeTokens {
    // Returns the RAW token once — only its sha256 is persisted.
    readonly mint: (label: string) => Promise<{ id: string; token: string }>;
    readonly verify: (presented: string) => Promise<boolean>;
    readonly list: () => Promise<BridgeTokenSummary[]>;
    readonly revoke: (id: string) => Promise<boolean>;
}

export const fileBridgeTokens = (path: string): BridgeTokens => {
    const file = jsonFile<StoredTokens>(path, {
        parse: (raw) => StoredTokensSchema.safeParse(raw).data,
        fallback: () => ({ tokens: [] }),
    });
    return {
        mint: async (label) => {
            const token = `ibt_${randomBytes(32).toString("base64url")}`;
            const id = randomUUID();
            await file.update((stored) => ({ tokens: [...stored.tokens, { id, label, hash: sha256Hex(token), createdAt: Date.now() }] }));
            return { id, token };
        },
        verify: async (presented) => {
            if (presented === "") {
                return false;
            }
            const hash = sha256Hex(presented);
            // Comparing fixed-length hex digests keeps the comparison timing-safe regardless of input length.
            return (await file.read()).tokens.some((entry) => tokenEquals(entry.hash, hash));
        },
        list: async () => (await file.read()).tokens.map(({ id, label, createdAt }) => ({ id, label, createdAt })),
        revoke: async (id) => {
            let revoked = false;
            await file.update((stored) => {
                const next = stored.tokens.filter((entry) => entry.id !== id);
                revoked = next.length !== stored.tokens.length;
                // Unchanged by reference when nothing matched, so revoking an absent id writes nothing.
                return revoked ? { tokens: next } : stored;
            });
            return revoked;
        },
    };
};

// The route surface a bridge token may drive — the agent-conversation seam and nothing else. A pure function
// so the allowlist is unit-tested apart from the middleware. Out-of-scope reads/mutations (files, secrets,
// capabilities, history restore…) stay owner-Google-only.
export const bridgeScoped = (method: string, path: string): boolean => {
    if (method === "POST") {
        return path === "/agent" || path === "/agent/reply";
    }
    if (method === "GET") {
        return path === "/sessions" || path.startsWith("/sessions/") || path === "/workspace/search";
    }
    return false;
};
