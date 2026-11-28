import type { IdentityPayload, IdentityReach } from "@intentic/extension-api";
import { generateKeySet, secretKeysOf, signExtensionPayload, signIdentity, extensionSignDomain } from "@intentic/sandbox-contract/s2s";
import type { SandboxIdentity } from "@intentic/sandbox-contract/schemas/s2s";
import { EXTENSION_ID } from "../log/entry.js";

// A sandbox's identity for tests: a real hybrid key set and the document it signed, signing as `api.identity` would for
// this extension, so what a test publishes verifies with the same pure functions a far reader uses.
export const testIdentity = (host = `sandbox-a.sbx.test`, sandbox = `a`): IdentityReach & { readonly current: () => SandboxIdentity } => {
    const keySet = generateKeySet();
    const document = signIdentity({ sandbox, name: `Sandbox ${sandbox}`, host, domains: [], issuedAt: Date.parse(`2026-11-28T00:00:00Z`) }, keySet);
    return {
        current: () => document,
        document: async () => document,
        sign: async (purpose: string, payload: IdentityPayload) => ({
            domain: extensionSignDomain(EXTENSION_ID, purpose),
            sig: signExtensionPayload(EXTENSION_ID, purpose, payload, secretKeysOf(keySet.secret)),
            fingerprint: document.fingerprint,
            document,
        }),
    };
};
