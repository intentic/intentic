import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CredentialGate, CredentialGateKind, SecretProgramGuard } from "@intentic/sandbox-contract/schemas/secrets";
import { createCredentialGrants } from "./credential-grants.js";
import { REACH_ALL } from "./credential-reach.js";
import { createDeviceSecrets } from "./device/device-secrets.js";
import { createKeyringNeeds, memoryKeyringNeeds } from "./device/keyring-needs.js";
import { createKeyringLink, type KeyringDevices } from "./device/keyring-link.js";
import { createKeyringSync, type KeyringSyncDevices } from "./device/keyring-sync.js";
import { memoryKeyringBook, memoryKeyringCopies, memoryReleasedValues, memorySandboxKeys, NO_DEVICES, SANDBOX_URL } from "./device/keyring.testing.js";
import { effectiveHostGuards, type StoredHostGuard } from "./guards/host-guards.js";
import { isStrict, NO_PROGRAMS, type ProgramGuard } from "./guards/program-guards.js";
import type { NamedSecret } from "./secret-registry.js";
import type { SecretUse } from "./secret-uses.js";
import type { SecretsSlice } from "./secrets-slice.js";

// The secrets slice as route suites stand it up (harness/route-services.testing.ts). Not part of the build.

// The real link and device-held secrets over memory stores: no keyring shares anything until a suite hands in a computer
// that does.
const keyringFakes = (devices: KeyringDevices & KeyringSyncDevices, secretRegistry: () => Promise<readonly NamedSecret[]>) => {
    const quiet = { warn: () => {} };
    // Read as empty and written only by a suite that carries the mailbox round, which stands up its own.
    const keyringSync = createKeyringSync({ devices: () => devices, mailboxPath: join(tmpdir(), "secrets-slice-fake", "keyring-sync-mailbox.json"), logger: quiet });
    const released = memoryReleasedValues();
    const sandboxKeyringKeys = memorySandboxKeys();
    const keyringLink = createKeyringLink({
        devices: () => devices,
        publicUrl: () => SANDBOX_URL,
        keys: sandboxKeyringKeys,
        book: memoryKeyringBook(),
        copies: memoryKeyringCopies(),
        released,
        syncOf: keyringSync.syncOf,
        logger: quiet,
    });
    return {
        keyringLink,
        keyringSync,
        sandboxKeyringKeys,
        deviceSecrets: createDeviceSecrets({ link: keyringLink, sync: keyringSync, released, registry: secretRegistry, devices: () => devices, logger: quiet }),
        keyringNeeds: createKeyringNeeds({ link: keyringLink, store: memoryKeyringNeeds(), logger: quiet }),
    };
};

// Every program guard unset until a suite writes one through the store; every widening let through, since the real card
// is tested where it lives (program-guard-gate.test.ts).
const programGuardFakes = () => {
    let programs: Record<string, ProgramGuard> = {};
    const guardFor = async (name: string): Promise<ProgramGuard> => programs[name] ?? NO_PROGRAMS;
    return {
        secretProgramGuards: {
            list: async (): Promise<SecretProgramGuard[]> =>
                Object.entries(programs).map(([subject, guard]) => ({ subject, programs: [...guard.programs], packages: [...guard.packages], anyField: guard.anyField })),
            guardFor,
            set: async (subject: string, guard: ProgramGuard) => {
                const { [subject]: _dropped, ...rest } = programs;
                programs = isStrict(guard) ? rest : { ...rest, [subject]: guard };
            },
        },
        programGuardFor: guardFor,
        programGuardGate: { widen: async () => ({}) },
    };
};

// `devices`: the owner's computers whose keyrings the link reaches; none unless a suite hands some in.
export const secretsSliceFake = (devices: KeyringDevices & KeyringSyncDevices = NO_DEVICES) => {
    const uses: SecretUse[] = [];
    let gates: CredentialGate[] = [];
    let kept: Record<string, string> = {};
    let stored: StoredHostGuard[] = [];
    // What the sandbox's own store below holds, as the real registry unions it; nothing else is stored. In-memory,
    // not unstubbed, since the inventory route reads it every call.
    const secretRegistry = async () => Object.entries(kept).map(([name, value]) => ({ name, value, source: "sandbox" as const }));
    return {
        secretRegistry,
        ...keyringFakes(devices, secretRegistry),
        ...programGuardFakes(),
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
        // Nobody limited, the state before an owner narrows a member; tested where it lives (credential-reach.test.ts).
        credentialReach: async () => REACH_ALL,
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
        // Nobody listens unless a suite subscribes; the announcing store is tested where it lives (sandbox-secrets.test.ts).
        onSecretsChanged: () => () => undefined,
        secretsChanged: () => undefined,
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
