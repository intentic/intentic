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
export const mintSandbox = async (prisma: PrismaClient, config: Config, data: { readonly name: string; readonly ownerId: string }) => {
    const token = randomBytes(16).toString(`base64url`);
    const sandbox = await prisma.sandbox.create({
        data: {
            ...data,
            token: encryptSecret(config, token),
            tokenDigest: sha256Hex(token),
            tunnelId: sandboxIdFromToken(token) ?? ``,
        },
        include: { hosted: true },
    });
    return { token, sandbox };
};
