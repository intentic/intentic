import { sandboxSubdomain } from "@intentic/sandbox-contract";
import { mintReachabilityGrant } from "@intentic/sandbox-contract/ingress-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import type { Config } from "../config.js";
import { decryptSecret } from "../crypto.js";

/* PROVISIONING REACHABILITY, which is no longer provisioning anything: it is a signature.
 *
 * WHAT THIS REPLACED. Under the zrok hub, "make this sandbox reachable" was STATE and a round trip. The
 * platform held the hub's admin token, minted one zrok ACCOUNT per sandbox over its API, cached the returned
 * account token (encrypted) in a `zrokToken` column, resolved and memoized the hub's public namespace, healed
 * duplicate mints through a delete-and-retry, revoked the account BEFORE deleting the row so a hub hiccup
 * could not strand an address nobody could release — and still leaked names the hub's own reaper had to
 * collect, because zrok v2 could create and delete accounts and do nothing else.
 *
 * Every one of those parts existed to answer "which sandbox may serve this hostname?", and the hostnames
 * already answer it: every public name a sandbox serves carries its own 12-hex id in the leftmost label
 * (`sandbox-<id>`, `preview-<panel>-<id>`, `port-<slot>-<id>`, `public-<slot>-<id>`). So ownership is a PARSE
 * the ingress does per request, and the only thing that has to be minted is proof of identity: a grant, signed
 * with the platform's Ed25519 key, saying "the bearer is sandbox <id>". ingress-contract.ts is the binding
 * shape, shared with the ingress that verifies and the daemon that presents.
 *
 * THE STATE → PURE FUNCTION COLLAPSE, in what is gone rather than in what is here: no hub call (so no
 * BAD_GATEWAY on this path, and no timeout budget), no cached column (so no encrypt/decrypt, no idempotency
 * argument, no "a mint whose row-write did not land"), no namespace to resolve or forget, no reconcile, no
 * reaper, and no teardown ordering — revocation is the row's deletion, which the ingress learns by asking
 * /api/reachability/<id> when a tunnel registers. Two functions, both synchronous, neither touching prisma.
 *
 * WHAT DID NOT CHANGE: the hostnames. `sandbox-<id>.<zone>` is the same derivation over the same digest of the
 * same connect token, under a wildcard zone that still points at one address. Only what sits behind the
 * wildcard moved, which is why the announce check, the wizard's address line, the browser's availability probe
 * and every link an owner has ever shared survive this untouched. */

/* THE SWITCH, and the same shape zrokEnabled had: a platform that cannot sign cannot make anything reachable,
 * so setup offers only the attach lane and the hosted lane is off. Empty is the right default for a developer
 * and for a self-hoster who has not stood an ingress up — reachability is simply a feature they do not have,
 * never a half-configured one that mints grants nothing will honor.
 *
 * The signing key AND the url, because they fail identically from the box's side: a grant with nowhere to
 * present it and a dial address with no grant to present both boot to a sandbox nobody can reach. */
export const ingressEnabled = (config: Config): boolean => config.ingress.signingKey !== `` && config.ingress.url !== ``;

// The sandbox's public address, digested from its connect token (tunnel-ids) under the ingress's wildcard
// zone. Deliberately the identical derivation the hub era used: this name is in DNS, in the daemon's announce
// and in links people have shared, and the fabric swap is not allowed to move it.
export const sandboxHostname = (zone: string, connectToken: string): string =>
    `${sandboxSubdomain(sandboxIdFromToken(connectToken) ?? ``)}.${zone}`;

// What a sandbox needs to be reachable, and the whole of it: proof of who it is, the name it answers under,
// and the edge it dials. Nothing here is stored — every field is re-derived on the next call, identically,
// from the row and the platform's config.
export interface Reachability {
    // The signed grant the daemon presents on the tunnel upgrade (SANDBOX_GRANT).
    readonly grant: string;
    readonly hostname: string;
    // The public base the BOX dials (INGRESS_URL). One address, not the hub era's platform/agent pair: the
    // ingress is on the public internet by construction, so there is no LAN-vs-outside view of it to reconcile.
    readonly ingressUrl: string;
}

/* Mint this sandbox's reachability. Named `ensure` for the callers' sake and because it keeps the guarantee the
 * hub-era function bought with a cached column: calling it twice never gives a sandbox a second identity, never
 * moves its address, and costs nothing. Here it holds for free — the grant is a signature over the sandbox's
 * own id, so every call is the same claim, and the bytes differ only in the `iat` the contract deliberately
 * gives no meaning (there is no expiry; the revocation that matters is the row being gone).
 *
 * Synchronous and prisma-free, which is the whole point: a route that used to hold an outbound HTTP call open
 * inside its own transaction window now computes a value. `token` is the ENCRYPTED column, decrypted here, so
 * callers hand over the row they already loaded. */
export const ensureReachability = (config: Config, sandbox: { id: string; token: string }): Reachability => {
    const connectToken = decryptSecret(config, sandbox.token);
    // `?? ""` rather than falling back to `sandbox.id`: the cuid primary key is not a 12-hex tunnel id, and a
    // grant minted for it would name a sandbox the ingress can never route to. The contract refuses the empty
    // string by its own guard, which is the honest failure for a row with no connect token to derive from.
    const sandboxId = sandboxIdFromToken(connectToken) ?? ``;
    return {
        grant: mintReachabilityGrant(config.ingress.signingKey, sandboxId, Date.now()),
        hostname: sandboxHostname(config.ingress.zone, connectToken),
        ingressUrl: config.ingress.url,
    };
};
