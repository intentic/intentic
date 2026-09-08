import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { mintReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../config.js";
import { decryptSecret } from "../crypto.js";

// Reachability is a signed claim, not provisioned state: every public hostname carries its sandbox's 12-hex id, so
// ownership is a parse the ingress does per request, and the only thing to mint is proof of identity (an Ed25519-signed
// grant, ingress-contract.ts). Two synchronous, prisma-free functions; revocation is just the row's deletion.

// Off entirely without both a signing key and a url: a grant with nowhere to present it, or an address with no grant,
// both fail identically. Empty is a valid off-state (dev, self-host with no ingress), not misconfiguration.
export const ingressEnabled = (config: Config): boolean => config.ingress.signingKey !== `` && config.ingress.url !== ``;

// Public address, digested from the connect token under the ingress's wildcard zone; load-bearing in DNS, the daemon's
// announce and shared links — must never change.
export const sandboxHostname = (zone: string, connectToken: string): string =>
    `${sandboxSubdomain(sandboxIdFromToken(connectToken) ?? ``)}.${zone}`;

// Everything a sandbox needs to be reachable: proof of identity, the name it answers under, the edge it dials — nothing
// stored, all re-derived each call.
export interface Reachability {
    // Signed grant the daemon presents on the tunnel upgrade (SANDBOX_GRANT).
    readonly grant: string;
    readonly hostname: string;
    // Public base the box dials (INGRESS_URL); the ingress is reachable from anywhere by construction.
    readonly ingressUrl: string;
}

// Idempotent for free: the grant signs the sandbox's own id, so every call makes the same claim (bytes differ only in a
// meaningless `iat`). Synchronous and prisma-free; `token` is the encrypted column, decrypted here.
export const ensureReachability = (config: Config, sandbox: { id: string; token: string }): Reachability => {
    const connectToken = decryptSecret(config, sandbox.token);
    // `?? ''`, not `sandbox.id`: the cuid key isn't a tunnel id; the contract itself refuses an empty string.
    const sandboxId = sandboxIdFromToken(connectToken) ?? ``;
    return {
        grant: mintReachabilityGrant(config.ingress.signingKey, sandboxId, Date.now()),
        hostname: sandboxHostname(config.ingress.zone, connectToken),
        ingressUrl: config.ingress.url,
    };
};
