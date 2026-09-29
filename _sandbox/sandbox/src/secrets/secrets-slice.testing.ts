import type { CredentialGate, CredentialGateKind } from "@intentic/sandbox-contract";
import { createCredentialGrants } from "./credential-grants.js";
import { effectiveHostGuards, type StoredHostGuard } from "./host-guards.js";
import type { SecretUse } from "./secret-uses.js";
import type { SecretsSlice } from "./secrets-slice.js";

// The secrets slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

export const secretsSliceFake = () => {
    const uses: SecretUse[] = [];
    let gates: CredentialGate[] = [];
    let kept: Record<string, string> = {};
    let stored: StoredHostGuard[] = [];
    return {
        // What the sandbox's own store below holds, as the real registry unions it; nothing else is stored. In-memory,
        // not unstubbed, since the inventory route reads it every call.
        secretRegistry: async () => Object.entries(kept).map(([name, value]) => ({ name, value, source: "sandbox" as const })),
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
        // Every host guard off until a suite writes one through the store, and no connector declares hosts: a suite that
        // wants a connector's default overrides `hostGuards`.
        secretHostGuards: {
            list: async () => stored,
            set: async (setting: StoredHostGuard) => {
                stored = [...stored.filter((entry) => entry.subject !== setting.subject || entry.kind !== setting.kind), setting];
            },
            remove: async (subject: string, kind: CredentialGateKind) => {
                stored = stored.filter((entry) => entry.subject !== subject || entry.kind !== kind);
            },
        },
        hostGuards: async () => effectiveHostGuards(stored, new Map()),
        // Lets everything through; the real check is tested where it lives (host-guard-gate.test.ts).
        hostGuardGate: { check: async () => ({ allow: true as const }), widen: async () => ({}) },
        // The sandbox's own store, in memory: what a need's card and a DevOps-less Secrets view write.
        sandboxSecrets: {
            all: async () => kept,
            get: async (name: string) => kept[name],
            set: async (name: string, value: string) => {
                kept = { ...kept, [name]: value };
            },
            remove: async (name: string) => {
                const had = name in kept;
                const { [name]: _dropped, ...rest } = kept;
                kept = rest;
                return had;
            },
        },
    } satisfies SecretsSlice;
};
