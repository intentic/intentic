import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import { z } from "zod";

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

const SIGNATURE_CHARS = 32;
const KEY_BYTES = 32;

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
const keyAt = async (path: string): Promise<Buffer> => {
    const existing = await readFile(path).catch(undefinedIfMissing);
    if (existing !== undefined && existing.length >= KEY_BYTES) {
        return existing;
    }
    const key = randomBytes(KEY_BYTES);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, key, { mode: 0o600 });
    return key;
};

export const brokerSessions = (keyPath: string): BrokerSessions => brokerSessionsFrom(() => keyAt(keyPath));

// Over any source of the key, read once and kept; a source that fails is asked again next time.
export const brokerSessionsFrom = (readKey: () => Promise<Buffer>): BrokerSessions => {
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
            .update(`broker:${payload}`)
            .digest("base64url")
            .slice(0, SIGNATURE_CHARS);
    return {
        tag: async (purpose) =>
            createHmac("sha256", await keyOnce())
                .update(`tag:${purpose}`)
                .digest("base64url")
                .slice(0, TAG_CHARS),
        sign: async ({ capability, route, upstream, conversationId }) => {
            const payload = Buffer.from(
                JSON.stringify({ i: capability, r: route, u: upstream, ...(conversationId !== undefined ? { c: conversationId } : {}) }),
            ).toString("base64url");
            return `${payload}.${await signatureOf(payload)}`;
        },
        verify: async (token) => {
            const [payload, signature, ...rest] = token.split(".");
            if (payload === undefined || signature === undefined || rest.length > 0 || payload === "") {
                return undefined;
            }
            const expected = Buffer.from(await signatureOf(payload));
            const given = Buffer.from(signature);
            if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
                return undefined;
            }
            try {
                const parsed = PayloadSchema.safeParse(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")));
                return parsed.success
                    ? { capability: parsed.data.i, route: parsed.data.r, upstream: parsed.data.u, conversationId: parsed.data.c }
                    : undefined;
            } catch {
                // allow(silent-catch): signed by this key yet unreadable can only be a payload a different build spelled differently.
                return undefined;
            }
        },
    };
};
