import { createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from "node:crypto";
import { SANDBOX_ID } from "../ids/tunnel-ids.js";

// A sandbox proves identity with a signed grant; a hostname's embedded id resolves ownership by parsing, not a registry
// lookup. Platform, ingress and daemon must agree on every string here. Routing is per h2 stream, since one TLS
// connection can carry multiple sandboxes' hosts.

// The reachability grant

// Version prefix: an ingress that doesn't recognize it refuses the tunnel rather than negotiating a shape.
const GRANT_PREFIX = "ig1";

const base64url = (bytes: Buffer): string => bytes.toString("base64url");

// Signed claim; wire fields are `sub` (12-hex sandbox id) and `iat` (seconds). No expiry: the grant lives for a
// container's whole life, and revocation is deleting the sandbox row.
export interface ReachabilityGrant {
    readonly sandboxId: string;
    readonly issuedAt: number;
}

// Mints a grant: an Ed25519 signature over the JSON `{sub, iat}` payload, with a PEM/PKCS8 private key.
export const mintReachabilityGrant = (privateKeyPem: string, sandboxId: string, issuedAtMs: number): string => {
    if (!SANDBOX_ID.test(sandboxId)) {
        throw new Error(`a reachability grant names a 12-hex sandbox id, got "${sandboxId}"`);
    }
    const payload = Buffer.from(JSON.stringify({ sub: sandboxId, iat: Math.floor(issuedAtMs / 1000) }), "utf8");
    const signature = edSign(null, payload, createPrivateKey(privateKeyPem));
    return `${GRANT_PREFIX}.${base64url(payload)}.${base64url(signature)}`;
};

// Verifies a grant against the platform's public key; any malformed shape returns undefined instead of throwing.
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

// Host to owner routing

// Resolves which sandbox owns a Host: the leftmost DNS label is `sandbox-<id>` or ends in `-<id>` (12-hex); anything
// else, including the loopback `<id>.local.<zone>` label, returns undefined.
export const hostOwnerId = (host: string): string | undefined => {
    const label = host.split(":")[0]?.split(".")[0] ?? "";
    const match = /-([0-9a-f]{12})$/.exec(label);
    return match === null ? undefined : match[1];
};

// Wire constants

// Tunnel door on the ingress; versioned so a v2 session shape adds a new path instead of replacing this one.
export const INGRESS_TUNNEL_PATH = "/tunnel/v1";

// Grant travels as a header on the tunnel upgrade; this connection is never a browser's.
export const INGRESS_GRANT_HEADER = "x-intentic-grant";

// Env vars every lane hands the daemon; the daemon reads them directly, not the entrypoint.
export const ENV_INGRESS_URL = "INGRESS_URL";
export const ENV_SANDBOX_GRANT = "SANDBOX_GRANT";

// The daemon-side surface

// Daemon-side tunnel behavior this contract requires: dial, register, forward to the loopback listener, and reconnect
// forever with backoff, never giving up. `close()` is for shutdown and tests.
export interface IngressTunnelOptions {
    // e.g. https://ingress.<zone>; the daemon derives the wss:// door itself via INGRESS_TUNNEL_PATH.
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

// What the ingress side must also honor, enforced by ingress-protocol tests:
// - Register: verify the grant offline; if PLATFORM_URL is set, check the sandbox exists (GET /api/reachability/<id>)
//   and cache the answer, failing open if the platform doesn't respond. A 404 refuses the tunnel.
// - Displacement: a new tunnel for an id closes the old session (code 4001) and takes the registration.
// - Liveness: WebSocket ping every 15s; a peer silent for 45s is unregistered.
// - Routing: host maps via hostOwnerId to a registered tunnel; no tunnel answers 502 naming the sandbox label.
// - The tunnel door and any host without a sandbox id are served directly by the ingress, never routed.
