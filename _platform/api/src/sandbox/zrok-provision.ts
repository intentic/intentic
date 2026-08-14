import { randomBytes } from "node:crypto";
import type { PrismaClient } from "@intentic-app/prisma";
import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../config.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { createSandboxAccount, publicNamespaceToken } from "./zrok.js";

/* PROVISIONING REACHABILITY, once per sandbox — the routes' shared half of the zrok swap (zrok.ts is the wire
 * client). What the Cloudflare path did in a dozen API calls is one account mint whose token is cached on the
 * row, so every later mint, hosted provision or re-run reuses it: the sandbox's address is a pure derivation
 * of its connect token, and its reachability grant is a single value.
 *
 * The namespace token is the hub's, not the sandbox's — the daemon needs it to attach its own names under the
 * wildcard frontend, so it rides the claim payload beside the account token. It is resolved once per process
 * and cached: it changes only if the hub is rebootstrapped, which is not a thing that happens under a running
 * platform. */

export const zrokEnabled = (config: Config): boolean => config.zrok.adminToken !== `` && config.zrok.apiEndpoint !== ``;

// The sandbox's public address — the SAME derivation the Cloudflare path used (sandbox-<id> from the connect
// token's digest), now under the hub's wildcard zone. Unchanged on purpose: the browser, the announce check
// and the wizard's address line all knew this shape before the fabric swapped underneath them.
export const sandboxHostname = (zone: string, connectToken: string): string => `${sandboxSubdomain(sandboxIdFromToken(connectToken) ?? ``)}.${zone}`;

let cachedNamespace: string | undefined;
const resolveNamespace = async (config: Config): Promise<string> => {
    cachedNamespace ??= await publicNamespaceToken(config.zrok);
    return cachedNamespace;
};

// Test seam + the reset a rebootstrapped hub would need.
export const forgetNamespace = (): void => {
    cachedNamespace = undefined;
};

export interface ZrokGrant {
    readonly accountToken: string;
    readonly namespaceToken: string;
    readonly hostname: string;
    // What the sandbox dials — the agent's view of the hub, which differs from the platform's whenever the
    // platform sits on the hub's LAN and the boxes come in from outside.
    readonly apiEndpoint: string;
}

/* The row's grant, minting it the first time. Idempotent by the cached column: a second setup mint, a hosted
 * provision after a pasted run, a re-run of a failed install — all reuse the one account, so a sandbox never
 * accumulates grants and its address never moves. */
export const ensureZrokAccount = async (
    prisma: PrismaClient,
    config: Config,
    sandbox: { id: string; token: string; zrokToken: string | null },
): Promise<ZrokGrant> => {
    const connectToken = decryptSecret(config, sandbox.token);
    const sandboxId = sandboxIdFromToken(connectToken) ?? sandbox.id;
    const namespaceToken = await resolveNamespace(config);
    const shared = {
        namespaceToken,
        hostname: sandboxHostname(config.zrok.zone, connectToken),
        apiEndpoint: config.zrok.agentEndpoint === `` ? config.zrok.apiEndpoint : config.zrok.agentEndpoint,
    };
    if (sandbox.zrokToken !== null) {
        return { accountToken: decryptSecret(config, sandbox.zrokToken), ...shared };
    }
    // Random and immediately forgotten: the account TOKEN is the credential that matters, nothing ever logs
    // in as this account, and an admin can reset the password if that ever changes.
    const { accountToken } = await createSandboxAccount(config.zrok, { sandboxId, password: randomBytes(24).toString(`base64url`) });
    await prisma.sandbox.update({ where: { id: sandbox.id }, data: { zrokToken: encryptSecret(config, accountToken) } });
    return { accountToken, ...shared };
};
