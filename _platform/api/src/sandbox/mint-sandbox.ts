import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import { sandboxIdFromToken, sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../config.js";
import { encryptSecret } from "../crypto.js";

/* THE ONE PLACE A SANDBOX ROW IS MINTED, for the signup path (sandbox.routes.ts) and the canary that proves the
 * signup path still works (hosted-canary.ts). The row's three derived columns all come off one connect token:
 * the encrypted token itself, the digest the daemon's announce is matched by, and `tunnelId`, the 12-hex id
 * every hostname this sandbox will ever serve is built from (sandboxIdFromToken). Stored rather than re-derived
 * because two readers need it as a KEY, the ingress's registration check and the DNS sweep, and neither can
 * decrypt a token or scan a table for a digest prefix. Two copies of that derivation is how the canary ends up
 * proving a path no user takes; one is how it cannot.
 *
 * The raw token is returned once, here, because the canary provisions with it and the signup hands it to the
 * setup mint; nothing else ever sees it unencrypted. */

// A fresh connect token. Also minted for a warm pool machine before anybody owns it (hosted-pool.ts), which
// is why the mint is its own function: an identity and a row are made in different places now.
export const mintConnectToken = (): string => randomBytes(16).toString(`base64url`);

/* The two columns a connect token implies, in one place so a row minted here and a row that ADOPTS a pool
 * machine's identity (hosted.ts claim) write the same derivation. `tunnelId` falls back to the empty string
 * only for an empty token, which the contract's own guard refuses upstream. */
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
