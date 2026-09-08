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
