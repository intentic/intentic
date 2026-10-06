import { join } from "node:path";
import { BROKER_PORT } from "@intentic/constants";
import { envSuffix } from "@intentic/sandbox-contract";
import { contributionFor, contributionRegistry } from "../contributions.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import type { CardDeps } from "../../guard/card-offers.js";
import { brokerOf, brokerRoutes } from "./broker-routes.js";
import { type CredentialPolicyStore, credentialPolicyDocument, fileCredentialPolicy } from "./broker-policy.js";
import { createRulePrompts } from "./broker-prompts.js";
import { brokerSessions, type BrokerSessions } from "./broker-session.js";
import type { RulePrompts } from "./broker-gateway.js";

// The credential gateway's own state: the key its addresses are signed with and the owner's per-card policy, both beside
// the vault in the auth root, and the passes a person's "allow in this conversation" leaves for the `ask` rules.

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
}

export interface BrokerDeps {
    readonly authRoot: string;
    readonly cards: CardDeps;
    // The installed connectors and connected cards, read live.
    readonly host: ExtensionHost;
}

export const BROKER_KEY_FILE = "broker-session.key";

export const createBrokerSlice = ({ authRoot, cards, host }: BrokerDeps): BrokerSlice => {
    const credentialPolicy = fileCredentialPolicy(join(authRoot, credentialPolicyDocument.path));
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
        brokerSessions: brokerSessions(join(authRoot, BROKER_KEY_FILE)),
        credentialPolicy,
        rulePrompts: createRulePrompts(cards),
        gatewayOrigin: `http://127.0.0.1:${String(BROKER_PORT)}`,
    };
};
