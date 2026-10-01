import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { z } from "zod";

// What a gateway URL carries: which provider the requests behind it are for (the trust decision), where they go next,
// and whose conversation they belong to (the log). Signed rather than looked up, so a runtime spawned before a daemon
// restart keeps working after it, and so the upstream can't be chosen by whoever holds a URL: without the signature the
// gateway would forward to any address it was handed.

export interface GatewaySession {
    readonly provider: string;
    readonly upstream: string;
    readonly conversationId?: string | undefined;
}

const PayloadSchema = z.object({ p: z.string().min(1), u: z.string().url(), c: z.string().optional() });

const SIGNATURE_CHARS = 32;

export interface SessionTokens {
    readonly sign: (session: GatewaySession) => Promise<string>;
    readonly verify: (token: string) => Promise<GatewaySession | undefined>;
}

// The signing key, created once and kept beside the vault: a key that changed on every boot would strand every runtime
// still holding an old URL.
const keyAt = async (path: string): Promise<Buffer> => {
    const existing = await readFile(path).catch(undefinedIfMissing);
    if (existing !== undefined && existing.length >= 32) {
        return existing;
    }
    const key = randomBytes(32);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, key, { mode: 0o600 });
    return key;
};

export const sessionTokens = (keyPath: string): SessionTokens => sessionTokensFrom(() => keyAt(keyPath));

// Over any source of the key, read once and kept; a source that fails is asked again next time.
export const sessionTokensFrom = (readKey: () => Promise<Buffer>): SessionTokens => {
    let key: Promise<Buffer> | undefined;
    const keyOnce = (): Promise<Buffer> => {
        key ??= readKey().catch((error: unknown) => {
            key = undefined;
            throw error;
        });
        return key;
    };
    const signatureOf = async (payload: string): Promise<string> =>
        createHmac("sha256", await keyOnce())
            .update(payload)
            .digest("base64url")
            .slice(0, SIGNATURE_CHARS);
    return {
        sign: async ({ provider, upstream, conversationId }) => {
            const payload = Buffer.from(
                JSON.stringify({ p: provider, u: upstream, ...(conversationId !== undefined ? { c: conversationId } : {}) }),
            ).toString("base64url");
            return `${payload}.${await signatureOf(payload)}`;
        },
        verify: async (token) => {
            const [payload, signature, ...rest] = token.split(".");
            if (payload === undefined || signature === undefined || rest.length > 0) {
                return undefined;
            }
            const expected = Buffer.from(await signatureOf(payload));
            const given = Buffer.from(signature);
            if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
                return undefined;
            }
            try {
                const parsed = PayloadSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
                return parsed.success ? { provider: parsed.data.p, upstream: parsed.data.u, conversationId: parsed.data.c } : undefined;
            } catch {
                // allow(silent-catch): signed by this key yet unreadable can only be a key reused across builds that spelled it differently.
                return undefined;
            }
        },
    };
};
