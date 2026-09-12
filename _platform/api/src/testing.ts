import { generateKeyPairSync } from "node:crypto";
import type { withHostedAppLock } from "./sandbox/hosted/hosted-app-lock.js";

const hostedAppLocks = new Map<string, Promise<void>>();

export const fakeHostedAppLock: typeof withHostedAppLock = async (_config, appName, wait, work) => {
    const held = hostedAppLocks.get(appName);
    if (held && !wait) {
        return undefined;
    }
    const done = Promise.withResolvers<void>();
    const queued = (held ?? Promise.resolve()).then(() => done.promise);
    hostedAppLocks.set(appName, queued);
    await held;
    try {
        return await work();
    } finally {
        done.resolve();
        if (hostedAppLocks.get(appName) === queued) {
            hostedAppLocks.delete(appName);
        }
    }
};

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
