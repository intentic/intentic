import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../config.js";
import { encryptSecret } from "../crypto.js";

// Mints a sandbox row for signup and the canary, deriving three columns from one connect token: the encrypted token,
// its digest (matched to the daemon's announce), and `tunnelId` (the hostname id) — stored so callers can use them as
// keys without decrypting. The raw token is returned once, here.

/* THESE VALUES END UP IN ARGV, so their alphabet is a contract and not a formatting choice. */

// base62: no `-`, no `_`, no padding. A secret is pasted into a shell one-liner and handed to `ic` as a
// positional, and base64url's `-` put one setup code in 64 in front of clap as a flag — `error: unexpected
// argument '-T' found`, mid-install, on a machine that had already got Docker ready. Nothing downstream
// decodes these, so the alphabet costs nothing: `sandboxIdFromToken` hashes the token as text.
const ALPHABET = `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`;
// 248 = 4 × 62: a byte at or above it would make the first eight letters likelier than the rest, so it is
// redrawn rather than folded.
const CEILING = 248;

/** A secret of `length` base62 characters, ~5.95 bits each, safe to pass as an argument to anything. */
export const argvSafeSecret = (length: number): string => {
    let secret = ``;
    while (secret.length < length) {
        for (const byte of randomBytes(length)) {
            if (byte < CEILING && secret.length < length) {
                secret += ALPHABET[byte % ALPHABET.length];
            }
        }
    }
    return secret;
};

// Fresh connect token; also minted for an unclaimed warm pool machine (hosted-pool.ts), which is why minting is
// separate from row creation. 22 characters is 131 bits, over the 128 the old 16 random bytes carried.
export const mintConnectToken = (): string => argvSafeSecret(22);

// Short-lived (30 minutes) and typed or pasted by a person, so it is as short as 65 bits allows — the entropy
// the 8 random bytes behind the old code carried.
export const mintSetupCode = (): string => argvSafeSecret(11);

// Derives tokenDigest and tunnelId from a connect token, shared by row creation and pool-identity adoption (hosted.ts)
// so both write the same derivation. `tunnelId` falls back to empty only for an empty token, refused upstream.
export const connectTokenIdentity = (token: string): { readonly tokenDigest: string; readonly tunnelId: string } => ({
    tokenDigest: sha256Hex(token),
    tunnelId: sandboxIdFromToken(token) ?? ``,
});

export const mintSandbox = async (prisma: PrismaClient, config: Config, data: { readonly name: string; readonly ownerId: string }) => {
    const token = mintConnectToken();
    const sandbox = await prisma.sandbox.create({
        data: {
            ...data,
            token: encryptSecret(config, token),
            ...connectTokenIdentity(token),
        },
        include: { hosted: true },
    });
    return { token, sandbox };
};
