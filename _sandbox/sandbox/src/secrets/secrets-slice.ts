import { join } from "node:path";
import type { SecretVault } from "../capabilities/credentials/secret-vault.js";
import type { CardDeps } from "../conversations/actor/card-offers.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { createCredentialGate, type CredentialGate } from "./credential-gate.js";
import { type CredentialGatesStore, fileCredentialGates } from "./credential-gates.js";
import { createCredentialGrants, type CredentialGrants } from "./credential-grants.js";
import { type NamedSecret, secretRegistryOf } from "./secret-registry.js";
import { fileSecretUses, secretUsesDocument, type SecretUsesStore } from "./secret-uses.js";

// Secret references, their uses, and the named-approver gates on spending them.
export interface SecretsSlice {
    // Every credential under a stable name; read by the agent's masking and the exits resolving a reference back.
    readonly secretRegistry: () => Promise<readonly NamedSecret[]>;
    // Use ledger those exits feed, one row per resolved reference, joined onto the secrets inventory as last-used.
    readonly secretUses: SecretUsesStore;
    // Which credentials need a person's click: policy is owner-written, grants in-memory, gate the shared consult.
    readonly credentialGates: CredentialGatesStore;
    readonly credentialGrants: CredentialGrants;
    readonly credentialGate: CredentialGate;
}

export interface SecretsDeps {
    readonly workspace: WorkspacePaths;
    // The AI-provider credential root; the approval policy sits beside the vault it guards, off the agent-editable config.
    readonly authRoot: string;
    // The capabilities' credential vault, the one the registry names every secret out of.
    readonly secretVault: SecretVault;
    // How a gate parks a turn on a release card and says so.
    readonly cards: CardDeps;
}

// Builds the secrets slice.
export const createSecretsSlice = ({ workspace, authRoot, secretVault, cards }: SecretsDeps): SecretsSlice => {
    const credentialGates = fileCredentialGates(join(authRoot, "credential-gates.json"));
    const credentialGrants = createCredentialGrants();
    return {
        secretRegistry: secretRegistryOf(secretVault, () => workspace.repos["desired-state"]),
        secretUses: fileSecretUses(join(workspace.root, secretUsesDocument.path)),
        credentialGates,
        credentialGrants,
        // Grants must be one map: a release clicked at the shell exit must be the release the browser reads next turn.
        credentialGate: createCredentialGate({ gates: credentialGates, grants: credentialGrants, ...cards }),
    };
};
