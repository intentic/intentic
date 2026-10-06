import { join } from "node:path";
import { BROKER_PORT } from "@intentic/constants";
import { envSuffix } from "@intentic/sandbox-contract";
import { contributionFor, contributionRegistry } from "../contributions.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import type { CardDeps } from "../../guard/card-offers.js";
import type { CredentialGate } from "../../secrets/gates/credential-gate.js";
import type { SecretUsesStore } from "../../secrets/secret-uses.js";
import { fileSshKeyStore, SSH_KEYS_DIR, type SshKeyStore } from "../ssh-key-store.js";
import { brokerOf, brokerRoutes } from "./broker-routes.js";
import { type CredentialPolicyStore, credentialPolicyDocument, fileCredentialPolicy } from "./broker-policy.js";
import { createRulePrompts } from "./broker-prompts.js";
import { brokerSessions, type BrokerSessions } from "./broker-session.js";
import type { RulePrompts } from "./broker-gateway.js";
import type { SshSignUse } from "./ssh-agent.js";
import { heldSshKeys } from "./ssh-agent-keys.js";
import { createSshAgentSockets, type SshAgentSockets } from "./ssh-agent-sockets.js";

// The credential broker's own state: the key the gateway's addresses are signed with and the owner's per-card policy,
// both beside the vault in the auth root, the passes a person's "allow in this conversation" leaves for the `ask` rules,
// and the SSH half: the private keys the sandbox holds (also in the auth root) and the ssh agent that signs with them.

// A registry name (`github/token`) whose credential the gateway holds, and the variables that reach its service instead.
export interface GatewayHeldSecret {
    readonly capability: string;
    readonly vars: readonly string[];
}

export interface BrokerSlice {
    // Whether a `{{secret:<capability>/<field>}}` reference names a credential the gateway holds, which no exit may then
    // resolve into a value: a command, a script or a page would hand the agent exactly what the gateway keeps from it.
    readonly gatewayHeld: (name: string) => Promise<GatewayHeldSecret | undefined>;
    readonly brokerSessions: BrokerSessions;
    readonly credentialPolicy: CredentialPolicyStore;
    readonly rulePrompts: RulePrompts & { readonly forget: (conversationId: string) => void };
    // Where the agent's shell reaches the gateway: loopback only, never relayed by netd.
    readonly gatewayOrigin: string;
    // Every private SSH key the sandbox holds; written by the ssh card and git access, read only by the ssh agent.
    readonly sshKeys: SshKeyStore;
    // The ssh agent's sockets: the owner's, and one per conversation (SSH_AUTH_SOCK in its turns).
    readonly sshAgent: SshAgentSockets;
}

export interface BrokerDeps {
    readonly authRoot: string;
    readonly cards: CardDeps;
    // The installed connectors and connected cards, read live.
    readonly host: ExtensionHost;
    // Who may release a gated card's key for a signature: the gate every credential exit consults.
    readonly credentialGate: Pick<CredentialGate, "check">;
    readonly secretUses: Pick<SecretUsesStore, "record">;
    readonly warn: (message: string, error?: unknown) => void;
    // Where the ssh agent's sockets live; the container's own run directory unless a test moves it.
    readonly sshAgentDir?: string;
}

export const BROKER_KEY_FILE = "broker-session.key";

// The container's, so it dies with every process that could hold one of its socket paths; short, since a socket path
// must fit in 107 bytes with a 64-character conversation id in it. A daemon that is not root (one run on someone's own
// machine) cannot write /run, and gets a directory of its own user's under /tmp instead.
export const sshAgentDirFor = (uid: number | undefined): string => (uid === undefined || uid === 0 ? "/run/intentic/ssh" : `/tmp/intentic-ssh-${String(uid)}`);

// One ledger row per key and conversation a minute at most, as the gateway does: an rsync over many connections signs
// once per connection.
const SIGN_RECORD_EVERY_MS = 60_000;

const signRecorder = (secretUses: Pick<SecretUsesStore, "record">, warn: BrokerDeps["warn"]): ((use: SshSignUse) => void) => {
    const last = new Map<string, number>();
    return (use) => {
        const now = Date.now();
        const key = `${use.ledgerName}\u0000${use.conversationId ?? ""}`;
        if (use.approvedBy === undefined && now - (last.get(key) ?? 0) < SIGN_RECORD_EVERY_MS) {
            return;
        }
        last.set(key, now);
        void secretUses
            .record({
                name: use.ledgerName,
                lane: "ssh",
                detail: `ssh ${use.alias}`,
                ...(use.approvedBy !== undefined ? { approvedBy: use.approvedBy } : {}),
                at: now,
            })
            .catch((error: unknown) => warn(`ssh agent: the use of "${use.alias}" could not be recorded`, error));
    };
};

export const createBrokerSlice = ({ authRoot, cards, host, credentialGate, secretUses, warn, sshAgentDir }: BrokerDeps): BrokerSlice => {
    const credentialPolicy = fileCredentialPolicy(join(authRoot, credentialPolicyDocument.path));
    const sessions = brokerSessions(join(authRoot, BROKER_KEY_FILE));
    const sshKeys = fileSshKeyStore(join(authRoot, SSH_KEYS_DIR));
    const gatewayHeld = async (name: string): Promise<GatewayHeldSecret | undefined> => {
        const slash = name.indexOf("/");
        if (slash === -1) {
            return undefined;
        }
        const id = name.slice(0, slash);
        const field = name.slice(slash + 1);
        const card = (await host.capabilities.list()).find((entry) => entry.id === id);
        if (card?.kind !== "cli") {
            return undefined;
        }
        const connector = contributionFor(await contributionRegistry(host), "cli", card.config);
        const broker = connector === undefined ? undefined : brokerOf(connector.spec);
        // allow(silent-catch): an unreadable policy reads as gateway delivery, which refuses the raw value rather than hands it over.
        const delivery = await credentialPolicy.of(id).then(
            (policy) => policy.delivery,
            () => "gateway" as const,
        );
        if (broker === undefined || delivery === "raw") {
            return undefined;
        }
        const routes = brokerRoutes(broker, card.config);
        if (!routes.some((route) => route.fields.includes(field))) {
            return undefined;
        }
        const suffix = envSuffix(id);
        return { capability: id, vars: routes.flatMap((route) => (route.env === undefined ? [] : [`${route.env}_${suffix}`])) };
    };
    return {
        gatewayHeld,
        brokerSessions: sessions,
        credentialPolicy,
        rulePrompts: createRulePrompts(cards),
        gatewayOrigin: `http://127.0.0.1:${String(BROKER_PORT)}`,
        sshKeys,
        sshAgent: createSshAgentSockets({
            dir: sshAgentDir ?? sshAgentDirFor(process.getuid?.()),
            tag: sessions.tag,
            keys: heldSshKeys({
                keys: sshKeys,
                capabilities: () => host.capabilities.list(),
                delivery: async (capability) => (await credentialPolicy.of(capability)).delivery ?? "gateway",
                warn,
            }),
            credentialGate,
            used: signRecorder(secretUses, warn),
            warn,
        }),
    };
};
