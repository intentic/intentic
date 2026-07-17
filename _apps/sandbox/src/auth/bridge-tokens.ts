import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
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

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

export const fileBridgeTokens = (path: string): BridgeTokens => {
    const read = async (): Promise<StoredTokens> => {
        try {
            const parsed = StoredTokensSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
            return parsed.success ? parsed.data : { tokens: [] };
        } catch {
            return { tokens: [] };
        }
    };
    const write = async (stored: StoredTokens): Promise<void> => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(stored, undefined, 2)}\n`);
    };
    return {
        mint: async (label) => {
            const token = `ibt_${randomBytes(32).toString("base64url")}`;
            const id = randomUUID();
            const stored = await read();
            await write({ tokens: [...stored.tokens, { id, label, hash: sha256(token), createdAt: Date.now() }] });
            return { id, token };
        },
        verify: async (presented) => {
            if (presented === "") {
                return false;
            }
            const hash = sha256(presented);
            // Comparing fixed-length hex digests keeps the comparison timing-safe regardless of input length.
            return (await read()).tokens.some((entry) => tokenEquals(entry.hash, hash));
        },
        list: async () => (await read()).tokens.map(({ id, label, createdAt }) => ({ id, label, createdAt })),
        revoke: async (id) => {
            const stored = await read();
            const next = stored.tokens.filter((entry) => entry.id !== id);
            if (next.length === stored.tokens.length) {
                return false;
            }
            await write({ tokens: next });
            return true;
        },
    };
};

// The route surface a bridge token may drive — the agent-conversation seam and nothing else. A pure function
// so the allowlist is unit-tested apart from the middleware. Out-of-scope reads/mutations (files, secrets,
// capabilities, history restore…) stay owner-Google-only.
export const bridgeScoped = (method: string, path: string): boolean => {
    if (method === "POST") {
        return path === "/agent" || path === "/agent/decision" || path === "/agent/answer";
    }
    if (method === "GET") {
        return path === "/sessions" || path.startsWith("/sessions/") || path === "/workspace/search";
    }
    return false;
};
