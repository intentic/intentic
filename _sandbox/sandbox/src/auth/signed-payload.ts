import { createHmac, timingSafeEqual } from "node:crypto";
import type { z } from "zod";
import { parseJsonWith } from "@intentic/base/json";

// A small JSON payload carried in an address and signed under a daemon key: `<payload>.<signature>`, the payload base64url
// JSON, the signature the first 32 characters of HMAC-SHA256 over it, base64url. The privacy gateway's session tokens
// and the credential broker's addresses are both this, and each used to carry its own copy of the code.
//
// `domain` is prepended to what the HMAC reads, so a key shared by two kinds of token can never let one pass as the
// other. The privacy gateway signs with none, and has to: every address it has already issued was signed over the bare
// payload, and a prefix added now would strand them all. The broker signs as `broker:`.

const SIGNATURE_CHARS = 32;

export interface SignedPayloads<Wire> {
    // The token for `wire`, which is serialised as given: key order is part of the signed bytes.
    readonly sign: (wire: Wire) => Promise<string>;
    // The payload of a token this key signed under this domain and the schema accepts; undefined for anything else.
    readonly verify: (token: string) => Promise<Wire | undefined>;
    // The key, read once and kept: what a holder needs to derive other tags under it (broker-session.ts `tag`).
    readonly key: () => Promise<Buffer>;
}

// `readKey` is asked once and its answer kept; a read that fails is not kept, so the next use asks again.
export const keptKey = (readKey: () => Promise<Buffer>): (() => Promise<Buffer>) => {
    let key: Promise<Buffer> | undefined;
    return () => {
        if (key !== undefined) {
            return key;
        }
        const loading = readKey();
        key = loading;
        loading.catch(() => {
            if (key === loading) {
                key = undefined;
            }
        });
        return loading;
    };
};

export const signedPayloads = <Schema extends z.ZodType>(
    readKey: () => Promise<Buffer>,
    schema: Schema,
    options: { readonly domain?: string } = {},
): SignedPayloads<z.output<Schema>> => {
    const key = keptKey(readKey);
    const domain = options.domain ?? "";
    const signatureOf = async (payload: string): Promise<string> =>
        createHmac("sha256", await key())
            .update(`${domain}${payload}`)
            .digest("base64url")
            .slice(0, SIGNATURE_CHARS);
    return {
        key,
        sign: async (wire) => {
            const payload = Buffer.from(JSON.stringify(wire)).toString("base64url");
            return `${payload}.${await signatureOf(payload)}`;
        },
        verify: async (token) => {
            const [payload, signature, ...rest] = token.split(".");
            // An empty payload is no JSON at all, so it is refused before the key is read for it.
            if (payload === undefined || payload === "" || signature === undefined || rest.length > 0) {
                return undefined;
            }
            const expected = Buffer.from(await signatureOf(payload));
            const given = Buffer.from(signature);
            if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
                return undefined;
            }
            // Signed by this key yet unreadable can only be a payload a different build spelled differently.
            return parseJsonWith(Buffer.from(payload, "base64url").toString("utf8"), schema);
        },
    };
};
