import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../config.js";
import { encryptSecret } from "../crypto.js";

// Mints a sandbox row for signup and the canary, deriving three columns from one connect token: the encrypted token,
// its digest (matched to the daemon's announce), and `tunnelId` (the hostname id) — stored so callers can use them as
// keys without decrypting. The raw token is returned once, here.

// Fresh connect token; also minted for an unclaimed warm pool machine (hosted-pool.ts), which is why minting is
// separate from row creation.
export const mintConnectToken = (): string => randomBytes(16).toString(`base64url`);

/* A SETUP CODE IS ARGV, so its alphabet is narrower than a token's. */

// No `-` and no `_`: the code is handed to `ic sandbox connect` as a positional and pasted into a shell
// one-liner, and base64url's `-` made one code in 64 start with a hyphen, which every argument parser reads
// as a flag rather than a value.
const CODE_ALPHABET = `0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz`;
// 11 characters of base62 is 65 bits, the entropy the 8 random bytes behind the old code carried.
const CODE_LENGTH = 11;
// 248 = 4 × 62: bytes at or above it would make the first eight letters likelier than the rest.
const CODE_CEILING = 248;

export const mintSetupCode = (): string => {
    let code = ``;
    while (code.length < CODE_LENGTH) {
        for (const byte of randomBytes(CODE_LENGTH)) {
            if (byte < CODE_CEILING && code.length < CODE_LENGTH) {
                code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
            }
        }
    }
    return code;
};

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
