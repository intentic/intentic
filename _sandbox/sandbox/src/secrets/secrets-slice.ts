import { join } from "node:path";
import type { SecretHostGuard } from "@intentic/sandbox-contract/schemas/secrets";
import type { Logger } from "pino";
import type { SecretVault } from "../capabilities/credentials/secret-vault.js";
import type { CardDeps } from "../guard/card-offers.js";
import type { HoldDeps } from "../guard/held-asks.js";
import type { HostHub } from "../hosts/host-peer.js";
import type { ConversationGrants } from "../personas/conversation-grants.js";
import type { WorkspacePaths } from "../workspace/workspace.js";
import { createDeviceSecrets, type DeviceSecretsService } from "./device/device-secrets.js";
import type { SandboxKeyringKeys } from "./device/keyring-keys.js";
import type { KeyringLink } from "./device/keyring-link.js";
import { createKeyringNeeds, fileKeyringNeeds, type KeyringNeeds, keyringNeedsDocument } from "./device/keyring-needs.js";
import { createKeyringParts } from "./device/keyring-parts.js";
import type { KeyringSync } from "./device/keyring-sync.js";
import { createProgramGuardGate, type ProgramGuardGate } from "./gates/program-guard-gate.js";
import { fileSecretProgramGuards, type ProgramGuard, type SecretProgramGuardsStore, secretProgramGuardsDocument } from "./guards/program-guards.js";
import { createCredentialGate, type CredentialGate } from "./gates/credential-gate.js";
import { type ConversationReachOf, type CredentialReachDeps, createConversationReach } from "./credential-reach.js";
import { type CredentialGatesStore, fileCredentialGates } from "./credential-gates.js";
import { type CredentialGrants, credentialReleasesDocument, fileCredentialGrants } from "./credential-grants.js";
import { createHostGuardGate, type HostGuardGate } from "./gates/host-guard-gate.js";
import { effectiveHostGuards, fileSecretHostGuards, type SecretHostGuardsStore, secretHostGuardsDocument } from "./guards/host-guards.js";
import { type NamedSecret, secretRegistryOf } from "./secret-registry.js";
import { fileSandboxSecrets, notifyingSandboxSecrets, type SandboxSecrets, sandboxSecretsDocument } from "./sandbox-secrets.js";
import { fileSecretUses, secretUsesDocument, type SecretUsesStore } from "./secret-uses.js";

// Secret references, their uses, the named-approver gates on spending them, and the hosts each may be sent to.
export interface SecretsSlice {
    // Every credential under a stable name; read by the agent's masking and the exits resolving a reference back.
    readonly secretRegistry: () => Promise<readonly NamedSecret[]>;
    // Use ledger those exits feed, one row per resolved reference, joined onto the secrets inventory as last-used.
    readonly secretUses: SecretUsesStore;
    // Which credentials need a person's click: policy is owner-written, releases kept in the auth root, gate the shared
    // consult.
    readonly credentialGates: CredentialGatesStore;
    readonly credentialGrants: CredentialGrants;
    readonly credentialGate: CredentialGate;
    // What a conversation may spend as the people it works for may: read by the turn's preflight and by the gate, so
    // a capability outside it is neither mounted nor spent (credential-reach.ts).
    readonly credentialReach: ConversationReachOf;
    // Secrets a person keeps without DevOps: pasted into a need's card, or added on the Secrets view.
    readonly sandboxSecrets: SandboxSecrets;
    // A secret was stored or removed here, by any door (the sandbox store, or desired-state/.env through the Secrets
    // routes, which call `secretsChanged`): open needs check now (2026-10-20). Answers the unsubscribe.
    readonly onSecretsChanged: (listener: () => void) => () => void;
    readonly secretsChanged: () => void;
    // Each secret's host guard, the second half of its approval beside the named approvers: the owner's settings,
    // stored beside the gate policy, and the guards in force once a connector's own hosts are laid under them.
    readonly secretHostGuards: SecretHostGuardsStore;
    readonly hostGuards: () => Promise<readonly SecretHostGuard[]>;
    // The check every exit makes before a host-guarded value leaves, sharing the gate's card seams.
    readonly hostGuardGate: HostGuardGate;
    // The keyrings on the owner's computers (device/): the link that reads the pointers each shares here and asks for a
    // value one use at a time, the sync mailbox between them, this sandbox's own keyring keys, and the device-held names
    // as the exits, the gates and the inventory read them.
    readonly keyringLink: KeyringLink;
    readonly keyringSync: KeyringSync;
    readonly sandboxKeyringKeys: SandboxKeyringKeys;
    readonly deviceSecrets: DeviceSecretsService;
    // An agent's need, by the place a credential is for, asked of the keyrings, and every need this sandbox raised.
    readonly keyringNeeds: KeyringNeeds;
    // Each sandbox-held secret's program guard, the host guard's counterpart for typing into a window or a phone app:
    // the owner's settings, the list a typing reads (empty when unset), and the card that widens one.
    readonly secretProgramGuards: SecretProgramGuardsStore;
    readonly programGuardFor: (name: string) => Promise<ProgramGuard>;
    readonly programGuardGate: ProgramGuardGate;
}

export interface SecretsDeps {
    readonly workspace: WorkspacePaths;
    // The AI-provider credential root; the approval policy sits beside the vault it guards, off the agent-editable config.
    readonly authRoot: string;
    // The capabilities' credential vault, the one the registry names every secret out of.
    readonly secretVault: SecretVault;
    // How a gate parks a turn on a release card and says so.
    readonly cards: CardDeps;
    // Where a card whose caller stopped waiting is held for the turn's close (guard/held-asks.ts).
    readonly hold: HoldDeps;
    // Hears the conversation whose releases a card answer or a take-back changed, so the Allowed list reads again.
    readonly releasesChanged?: (conversationId: string) => void;
    // Where a host guard card's "anywhere in this conversation" is kept, and read at every later use.
    readonly conversationGrants: Pick<ConversationGrants, "of" | "add">;
    // The hosts each connected capability's connector declares for its credential (host-guards.ts connectorHostDefaults).
    readonly connectorHosts: () => Promise<ReadonlyMap<string, readonly string[]>>;
    // Who may loosen a guard on a card the agent raised, and the one person no reach ever limits.
    readonly ownerEmail: () => Promise<string | undefined>;
    // The roster each member's reach is written on, and the conversation records that name who a conversation works for.
    readonly members: CredentialReachDeps["members"];
    readonly conversationEntry: CredentialReachDeps["entry"];
    // Where a release that could not be kept is said; the release itself still holds for this process.
    readonly warn: (message: string, error: unknown) => void;
    // The owner's computers, for their keyrings: the hub is composed after this slice, so it is read at each call.
    readonly deviceHub: () => Pick<HostHub, "connected" | "client" | "state">;
    // This sandbox's public address, which every keyring grant names.
    readonly publicUrl: () => string;
    readonly logger: Pick<Logger, "warn">;
}

// Builds the secrets slice.
export const createSecretsSlice = ({
    workspace,
    authRoot,
    secretVault,
    cards,
    hold,
    releasesChanged,
    conversationGrants,
    connectorHosts,
    ownerEmail,
    members,
    conversationEntry,
    warn,
    deviceHub,
    publicUrl,
    logger,
}: SecretsDeps): SecretsSlice => {
    const credentialGates = fileCredentialGates(join(authRoot, "credential-gates.json"));
    const keptReleases = fileCredentialGrants(join(authRoot, credentialReleasesDocument.path), (error) =>
        warn("credential releases: the stored releases could not be read or written", error),
    );
    const credentialGrants = releasesChanged === undefined ? keptReleases : notifyingCredentialGrants(keptReleases, releasesChanged);
    const secretsListeners = new Set<() => void>();
    const secretsChanged = (): void => {
        for (const listener of secretsListeners) {
            listener();
        }
    };
    const sandboxSecrets = notifyingSandboxSecrets(fileSandboxSecrets(join(authRoot, sandboxSecretsDocument.path)), secretsChanged);
    const credentialReach = createConversationReach({ members, ownerEmail, entry: conversationEntry });
    const secretHostGuards = fileSecretHostGuards(join(authRoot, secretHostGuardsDocument.path));
    // Read fresh each call, like the registry: a guard the owner tightens mid-turn holds from the very next use.
    const hostGuards = async (): Promise<readonly SecretHostGuard[]> => {
        const [stored, defaults] = await Promise.all([secretHostGuards.list(), connectorHosts()]);
        return effectiveHostGuards(stored, defaults);
    };
    const keyrings = createKeyringParts({ authRoot, hub: deviceHub, publicUrl, logger });
    const secretRegistry = secretRegistryOf(secretVault, () => workspace.repos["desired-state"], sandboxSecrets, {
        copies: () => keyrings.keyringCopies.all(),
        released: () => keyrings.releasedDeviceValues.all(),
    });
    const deviceSecrets = createDeviceSecrets({
        link: keyrings.keyringLink,
        sync: keyrings.keyringSync,
        released: keyrings.releasedDeviceValues,
        registry: secretRegistry,
        devices: () => keyrings.devices,
        logger,
    });
    const secretProgramGuards = fileSecretProgramGuards(join(authRoot, secretProgramGuardsDocument.path));
    return {
        secretHostGuards,
        hostGuards,
        keyringLink: keyrings.keyringLink,
        keyringSync: keyrings.keyringSync,
        sandboxKeyringKeys: keyrings.keyringKeys,
        deviceSecrets,
        keyringNeeds: createKeyringNeeds({ link: keyrings.keyringLink, store: fileKeyringNeeds(join(authRoot, keyringNeedsDocument.path)), logger }),
        secretProgramGuards,
        programGuardFor: (name) => secretProgramGuards.guardFor(name),
        programGuardGate: createProgramGuardGate({ ownerEmail, ...cards, hold }),
        hostGuardGate: createHostGuardGate({
            // A device-held name's keyring hosts first: the owner's own guards are for what the sandbox holds.
            guards: async () => [...(await deviceSecrets.guards()), ...(await hostGuards())],
            ownerEmail,
            grants: {
                of: async (conversationId) => (await conversationGrants.of(conversationId))?.secrets ?? [],
                add: async (conversationId, names, by) => {
                    for (const name of names) {
                        await conversationGrants.add(conversationId, { subject: "secret", what: name }, by);
                    }
                },
            },
            ...cards,
            hold,
        }),
        sandboxSecrets,
        onSecretsChanged: (listener) => {
            secretsListeners.add(listener);
            return () => void secretsListeners.delete(listener);
        },
        secretsChanged,
        secretRegistry,
        secretUses: fileSecretUses(join(workspace.root, secretUsesDocument.path)),
        credentialGates,
        credentialGrants,
        credentialReach,
        // Grants must be one map: a release clicked at the shell exit must be the release the browser reads next turn.
        credentialGate: createCredentialGate({ gates: credentialGates, grants: credentialGrants, reach: credentialReach, ...cards, hold }),
    };
};

// Releases are kept by the secrets slice and read synchronously by the gates, so they are announced by wrapping the store
// rather than from inside it: every release, take-back and forgetting tells `changed` which conversation moved, so the
// list where a person takes a yes back moves with it. A take-back that found nothing is no news.
export const notifyingCredentialGrants = (grants: CredentialGrants, changed: (conversationId: string) => void): CredentialGrants => {
    const tell = (conversationId: string): void => {
        try {
            changed(conversationId);
        } catch {
            // allow(silent-catch): the announcement only refreshes a view; the release is already made or taken back, and its failure must not undo or fail that.
        }
    };
    return {
        ...grants,
        grant: (conversationId, subject, grant) => {
            grants.grant(conversationId, subject, grant);
            tell(conversationId);
        },
        revoke: (conversationId, subject) => {
            const revoked = grants.revoke(conversationId, subject);
            if (revoked) {
                tell(conversationId);
            }
            return revoked;
        },
        forget: (conversationId) => {
            const had = grants.all().some((release) => release.conversationId === conversationId);
            grants.forget(conversationId);
            if (had) {
                tell(conversationId);
            }
        },
    };
};
