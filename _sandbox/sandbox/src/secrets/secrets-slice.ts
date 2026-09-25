import type { CredentialGate } from "./credential-gate.js";
import type { CredentialGatesStore } from "./credential-gates.js";
import type { CredentialGrants } from "./credential-grants.js";
import type { NamedSecret } from "./secret-registry.js";
import type { SecretUsesStore } from "./secret-uses.js";

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
