import { generateKeyPairSync } from "node:crypto";

/* SHARED FIXTURES for the platform api's suites. One per seam, by the house rule: a copy in each test file
 * cannot be updated when the shape grows, so it quietly starts describing a system that no longer exists.
 *
 * THE INGRESS KEYPAIR is the only thing minting reachability needs (sandbox/reachability.ts), and it is real
 * rather than faked: a grant is Ed25519 over a canonical payload, so there is no provider to stand in for and
 * nothing to stub — a test signs with this key and verifies with its public half, which is exactly what the
 * ingress does. This is the seam that replaced the hub double the platform's suites used to stand up, and the
 * replacement is smaller than the thing it replaced by the whole size of an HTTP server.
 *
 * Generated once per process. Ed25519 keygen is sub-millisecond, and a fixed literal PEM would be a secret
 * shape checked into a repository, which is a thing that gets copied. */
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

export const INGRESS_TEST_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
export const INGRESS_TEST_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();

/* The `ingress` config block of a platform that CAN make sandboxes reachable, for the suites that assert on the
 * handdown. `sbx.test` keeps every derived hostname in a zone no real deployment owns. */
export const testIngressConfig = {
    zone: `sbx.test`,
    url: `https://ingress.sbx.test`,
    signingKey: INGRESS_TEST_PRIVATE_KEY,
};
