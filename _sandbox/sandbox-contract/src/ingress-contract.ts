import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";

/* THE INGRESS CONTRACT: how a sandbox is reached now that the reachability fabric is the platform's OWN edge
 * (the `@intentic/ingress` app on Fly) instead of a zrok hub. Node-only (crypto), like ./tunnel-ids beside it;
 * shared by the platform (mints grants), the ingress (verifies grants, routes hosts), and the daemon (dials
 * the tunnel). The three MUST agree on every string in this file, which is why it exists.
 *
 * WHAT REPLACED WHAT. Under zrok, reachability was STATE: an account minted per sandbox over the hub's admin
 * API, names claimed one by one, shares bound to them, and a reaper collecting what the soft-deletes leaked.
 * Every piece of that state existed to answer one question — "which sandbox may serve this hostname?" — that
 * the hostnames ALREADY answer by construction: every public name a sandbox serves ends in its own 12-hex id
 * (`sandbox-<id>`, `preview-<panel>-<id>`, `port-<slot>-<id>`, `public-<slot>-<id>`; hostnames.ts is the
 * single source). So ownership is a PARSE, not a registry, and the only thing that has to be minted is proof
 * of identity: a grant, signed by the platform, saying "the bearer is sandbox <id>". Provisioning reachability
 * becomes a pure function — no hub round trip, no row to cache a token on, no orphan to reconcile, and
 * revoking it is deleting the sandbox row (the ingress asks the platform on register, below).
 *
 * THE FLOW. The daemon dials ONE outbound WebSocket to the ingress (INGRESS_TUNNEL_PATH) presenting its grant
 * in INGRESS_GRANT_HEADER. The ingress verifies the signature offline, registers the tunnel under grant.sub,
 * and from then on routes every edge request whose Host's leftmost label ends in `-<that id>` (or is exactly
 * `sandbox-<id>`) down that tunnel. A second tunnel for the same id DISPLACES the first — the new container is
 * by definition the live one, which is what buries the zrok-era stale-share reclaim dance (a recreated box
 * used to fight the hub over names its dead predecessor still held; here the fight cannot exist).
 *
 * THE DATA PLANE over the tunnel is an HTTP/2 cleartext session runs over the WebSocket's binary stream:
 * the ingress side opens an http2 CLIENT session over the duplex (node's http2.connect with createConnection),
 * the daemon side feeds the duplex to an http2 SERVER session, and each edge request becomes one h2 stream
 * with the original :authority preserved, which the daemon's client forwards to its own loopback listener
 * (the Hono app already dispatches previews by Host). WebSocket upgrades ride CONNECT-method streams carrying
 * the raw upgraded bytes. All of it is node core — the mux, flow control and per-stream backpressure are
 * h2's own, not ours to reimplement. The implementation lives in ./ingress-protocol.ts (both halves, one
 * owner); this file pins only what every party must agree on.
 *
 * WHY PER-REQUEST ROUTING IS NOT OPTIONAL: the edge terminates TLS under ONE wildcard certificate, and h2
 * browsers coalesce connections across every hostname a certificate covers — one TCP connection can carry
 * `sandbox-a…` and `preview-x-b…` interleaved. Routing a CONNECTION by its first Host would send one
 * sandbox's requests to another. The unit of routing is the request (h2 stream), never the connection. */

// ── The reachability grant ──────────────────────────────────────────────────────────────────────────────

/* Version prefix, so a future shape can coexist during a key rotation. Not a negotiation: an ingress that
 * does not know a prefix refuses the tunnel, and the box retries until its operator updates something. */
const GRANT_PREFIX = "ig1";

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

// The signed claim. `sub` is the sandbox's 12-hex id (sandboxIdFromToken in ./tunnel-ids); `iat` is seconds.
// Deliberately no expiry: the grant lives in a container's env for the container's whole life, and the
// revocation that matters (the sandbox being deleted) is answered by the platform on register, not by time.
export interface ReachabilityGrant {
    readonly sandboxId: string;
    readonly issuedAt: number;
}

const SANDBOX_ID = /^[0-9a-f]{12}$/;

/* Mint a grant: Ed25519 over the canonical payload bytes. Ed25519 because node signs/verifies it with key
 * objects alone (no hash negotiation, no padding modes), signatures are 64 bytes, and the platform already
 * depends on nothing for it — the private key is config (PEM, PKCS8), the public key rides the ingress env. */
export const mintReachabilityGrant = (privateKeyPem: string, sandboxId: string, issuedAtMs: number): string => {
    if (!SANDBOX_ID.test(sandboxId)) {
        throw new Error(`a reachability grant names a 12-hex sandbox id, got "${sandboxId}"`);
    }
    const payload = Buffer.from(JSON.stringify({ sub: sandboxId, iat: Math.floor(issuedAtMs / 1000) }), "utf8");
    const signature = edSign(null, payload, createPrivateKey(privateKeyPem));
    return `${GRANT_PREFIX}.${base64url(payload)}.${base64url(signature)}`;
};

/* Verify a grant against the platform's public key. Every malformed shape answers undefined rather than
 * throwing: this runs on the ingress's unauthenticated door, where a garbage token is weather, not a fault. */
export const verifyReachabilityGrant = (publicKeyPem: string, token: string): ReachabilityGrant | undefined => {
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== GRANT_PREFIX) {
        return undefined;
    }
    try {
        const payload = Buffer.from(parts[1] as string, "base64url");
        const signature = Buffer.from(parts[2] as string, "base64url");
        if (!edVerify(null, payload, createPublicKey(publicKeyPem), signature)) {
            return undefined;
        }
        const parsed = JSON.parse(payload.toString("utf8")) as { sub?: unknown; iat?: unknown };
        if (typeof parsed.sub !== "string" || !SANDBOX_ID.test(parsed.sub) || typeof parsed.iat !== "number") {
            return undefined;
        }
        return { sandboxId: parsed.sub, issuedAt: parsed.iat };
    } catch {
        return undefined;
    }
};

// ── Host → owner routing ────────────────────────────────────────────────────────────────────────────────

/* Which sandbox may serve this Host. The leftmost DNS label either IS `sandbox-<id>` or ends in `-<id>`
 * (preview/port/public labels, hostnames.ts) — a fixed-length tail, so label keys containing `-` stay
 * unambiguous. Anything else (the ingress's own name, the zone apex, a stray subdomain) answers undefined,
 * which the ingress turns into its 404. The loopback name (`<id>.local.<zone>`) never reaches the ingress —
 * it resolves to 127.0.0.1 — and its bare-id label deliberately does not match here. */
export const hostOwnerId = (host: string): string | undefined => {
    const label = host.split(":")[0]?.split(".")[0] ?? "";
    const match = /-([0-9a-f]{12})$/.exec(label);
    return match === null ? undefined : match[1];
};

// ── Wire constants ──────────────────────────────────────────────────────────────────────────────────────

/* The tunnel door on the ingress. Versioned in the path so a v2 session shape is a new door, not a flag day:
 * the ingress serves both for as long as old containers exist. Checked BEFORE host routing — the ingress's own
 * hostname carries no sandbox id on purpose. */
export const INGRESS_TUNNEL_PATH = "/tunnel/v1";

// The grant rides a header on the tunnel upgrade (a Node client can set one; this is never a browser).
export const INGRESS_GRANT_HEADER = "x-intentic-grant";

/* The env vocabulary, every lane (connect one-liner, compose file, hosted machine env) hands the same pair
 * down and the DAEMON reads exactly these names — the entrypoint reads neither, and that is the shape of the
 * change: reachability stopped being something a shell script arranges before the daemon starts and became
 * one outbound dial the daemon makes for itself. SANDBOX_PUBLIC_URL is unchanged from the fabric before this
 * one and stays beside them. */
export const ENV_INGRESS_URL = "INGRESS_URL";
export const ENV_SANDBOX_GRANT = "SANDBOX_GRANT";

// ── The daemon-side surface (pinned for the boot wiring) ────────────────────────────────────────────────

/* The daemon-side tunnel behavior this contract requires. Dial, register, forward to the loopback listener,
 * reconnect forever with backoff —
 * the tunnel is the sandbox's reachability, so like the zrok agent's restart loop it never gives up, it only
 * ever waits longer. close() is for shutdown and tests. */
export interface IngressTunnelOptions {
    // e.g. https://ingress.<zone>. The daemon derives the wss:// door itself (INGRESS_TUNNEL_PATH).
    readonly url: string;
    readonly grant: string;
    // The daemon's own loopback listener; every h2 stream lands there as a plain HTTP/1.1 request or upgrade.
    readonly targetPort: number;
    readonly log: (message: string, error?: unknown) => void;
}

export interface IngressTunnelHandle {
    readonly close: () => Promise<void>;
    // For /health and the boot log: whether the tunnel currently holds a registered session.
    readonly connected: () => boolean;
}

export type StartIngressTunnel = (options: IngressTunnelOptions) => IngressTunnelHandle;

/* ── What the INGRESS side must also honor (spec, enforced by ingress-protocol tests) ──────────────────────
 *
 *  • Register: verify the grant offline; then, when PLATFORM_URL is configured, ask the platform whether the
 *    sandbox still exists (GET /api/reachability/<id>, 200/404, answer cached; fail-OPEN on a platform that
 *    does not answer — reachability must not depend on the platform being up, that is the whole point of the
 *    platform being off the hot path). A 404 refuses the tunnel: that is revocation.
 *  • Displacement: a new tunnel for an id closes the old session (code 4001) and takes the registration.
 *  • Liveness: WebSocket ping every 15s; a peer silent for 45s is dead and unregistered.
 *  • Routing: request host → hostOwnerId → registered tunnel; no tunnel answers 502 with a body naming the
 *    sandbox label (the browser's availability flow reads any 5xx as "sandbox unreachable" and drives wake).
 *  • The tunnel door itself (INGRESS_TUNNEL_PATH) and anything not carrying a sandbox-id host answer on the
 *    ingress directly; they are never routed. */
