import type { CredentialGate } from "@intentic/sandbox-contract";
import { createCredentialGrants } from "./credential-grants.js";
import type { SecretUse } from "./secret-uses.js";
import type { SecretsSlice } from "./secrets-slice.js";

// The secrets slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const secretsSliceFake = () => {
    const uses: SecretUse[] = [];
    let gates: CredentialGate[] = [];
    return {
        // Nothing stored or spent; in-memory, not unstubbed, since the inventory route reads it every call.
        secretRegistry: async () => [],
        secretUses: {
            record: async (use: SecretUse) => {
                uses.push(use);
            },
            all: async () => uses,
        },
        // Nothing gated, the state before an owner names an approver; a suite that wants one writes it through the
        // store. In-memory, not unstubbed, since inventory reads it every call.
        credentialGates: {
            list: async () => gates,
            set: async (gate: CredentialGate) => {
                gates = [...gates.filter((entry) => entry.subject !== gate.subject), gate];
            },
            remove: async (subject: string) => {
                gates = gates.filter((entry) => entry.subject !== subject);
            },
            forName: async () => undefined,
            forCapability: async () => undefined,
        },
        credentialGrants: createCredentialGrants(),
        // Nothing gated above, so this allows everything and asks nobody; tested where the real gate lives.
        credentialGate: { check: async () => ({ allow: true as const }) },
    } satisfies SecretsSlice;
};
