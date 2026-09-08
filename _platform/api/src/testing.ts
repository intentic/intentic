import { generateKeyPairSync } from "node:crypto";

// Shared fixtures for the platform api's suites, one per seam. The ingress keypair is real, not faked: a grant is
// Ed25519 over a canonical payload, so tests sign and verify with it directly, with nothing to stub. Generated once per
// process rather than a literal PEM, which would be a secret shape checked into the repo.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

export const INGRESS_TEST_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
export const INGRESS_TEST_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();

// Ingress config for a reachable-sandboxes platform; `sbx.test` keeps hostnames in a zone nobody real owns.
export const testIngressConfig = {
    zone: `sbx.test`,
    url: `https://ingress.sbx.test`,
    signingKey: INGRESS_TEST_PRIVATE_KEY,
};
