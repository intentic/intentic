import { join } from "node:path";
import type { SecretHostGuard } from "@intentic/sandbox-contract";
import type { SecretVault } from "../capabilities/credentials/secret-vault.js";
import type { CardDeps } from "../conversations/actor/card-offers.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { createCredentialGate, type CredentialGate } from "./credential-gate.js";
import { type CredentialGatesStore, fileCredentialGates } from "./credential-gates.js";
import { type CredentialGrants, credentialReleasesDocument, fileCredentialGrants } from "./credential-grants.js";
import { createHostGuardGate, type HostGuardGate } from "./host-guard-gate.js";
import { effectiveHostGuards, fileSecretHostGuards, type SecretHostGuardsStore, secretHostGuardsDocument } from "./host-guards.js";
import { type NamedSecret, secretRegistryOf } from "./secret-registry.js";
import { fileSandboxSecrets, type SandboxSecrets, sandboxSecretsDocument } from "./sandbox-secrets.js";
import { fileSecretUses, secretUsesDocument, type SecretUsesStore } from "./secret-uses.js";

// Secret references, their uses, the named-approver gates on spending them, and the hosts each may be sent to.
export interface SecretsSlice {
    // Every credential under a stable name; read by the agent's masking and the exits resolving a reference back.
    readonly secretRegistry: () => Promise<readonly NamedSecret[]>;
    // Use ledger those exits feed, one row per resolved reference, joined onto the secrets inventory as last-used.
    readonly secretUses: SecretUsesStore;
    // Which credentials need a person's click: policy is owner-written, grants in-memory, gate the shared consult.
    readonly credentialGates: CredentialGatesStore;
    readonly credentialGrants: CredentialGrants;
    readonly credentialGate: CredentialGate;
    // Secrets a person keeps without DevOps: pasted into a need's card, or added on the Secrets view.
    readonly sandboxSecrets: SandboxSecrets;
    // Each secret's host guard, the second half of its approval beside the named approvers: the owner's settings,
    // stored beside the gate policy, and the guards in force once a connector's own hosts are laid under them.
    readonly secretHostGuards: SecretHostGuardsStore;
    readonly hostGuards: () => Promise<readonly SecretHostGuard[]>;
    // The check every exit makes before a host-guarded value leaves, sharing the gate's card seams.
    readonly hostGuardGate: HostGuardGate;
}

export interface SecretsDeps {
    readonly workspace: WorkspacePaths;
    // The AI-provider credential root; the approval policy sits beside the vault it guards, off the agent-editable config.
    readonly authRoot: string;
    // The capabilities' credential vault, the one the registry names every secret out of.
    readonly secretVault: SecretVault;
    // How a gate parks a turn on a release card and says so.
    readonly cards: CardDeps;
    // The hosts each connected capability's connector declares for its credential (host-guards.ts connectorHostDefaults).
    readonly connectorHosts: () => Promise<ReadonlyMap<string, readonly string[]>>;
    // Who may loosen a guard on a card the agent raised.
    readonly ownerEmail: () => Promise<string | undefined>;
    // Where a release that could not be kept is said; the release itself still holds for this process.
    readonly warn: (message: string, error: unknown) => void;
}

// Builds the secrets slice.
export const createSecretsSlice = ({ workspace, authRoot, secretVault, cards, connectorHosts, ownerEmail, warn }: SecretsDeps): SecretsSlice => {
    const credentialGates = fileCredentialGates(join(authRoot, "credential-gates.json"));
    const credentialGrants = fileCredentialGrants(join(authRoot, credentialReleasesDocument.path), (error) =>
        warn("credential releases: the stored releases could not be read or written", error),
    );
    const sandboxSecrets = fileSandboxSecrets(join(authRoot, sandboxSecretsDocument.path));
    const secretHostGuards = fileSecretHostGuards(join(authRoot, secretHostGuardsDocument.path));
    // Read fresh each call, like the registry: a guard the owner tightens mid-turn holds from the very next use.
    const hostGuards = async (): Promise<readonly SecretHostGuard[]> => {
        const [stored, defaults] = await Promise.all([secretHostGuards.list(), connectorHosts()]);
        return effectiveHostGuards(stored, defaults);
    };
    return {
        secretHostGuards,
        hostGuards,
        hostGuardGate: createHostGuardGate({ guards: hostGuards, ownerEmail, ...cards }),
        sandboxSecrets,
        secretRegistry: secretRegistryOf(secretVault, () => workspace.repos["desired-state"], sandboxSecrets),
        secretUses: fileSecretUses(join(workspace.root, secretUsesDocument.path)),
        credentialGates,
        credentialGrants,
        // Grants must be one map: a release clicked at the shell exit must be the release the browser reads next turn.
        credentialGate: createCredentialGate({ gates: credentialGates, grants: credentialGrants, ...cards }),
    };
};
