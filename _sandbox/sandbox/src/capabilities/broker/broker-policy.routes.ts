import { type CredentialPolicy, secretsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../../app-env.js";
import { isOwnerBearer } from "../../auth/owner-gates.js";
import { contributionFor, contributionRegistry } from "../contributions.js";
import { loadPrivateKey } from "../credentials/ssh-keys.js";
import type { Services } from "../../composition.js";
import type { ExtensionHost } from "../../extensions/installed-extensions.js";
import type { CredentialPolicyStore } from "./broker-policy.js";
import { brokerOf } from "./broker-routes.js";

// The credential gateway's policy as people and the agent read it: for each connected command-line tool, how its
// credential reaches the agent and the rules the gateway enforces, and for each SSH machine whether the sandbox's ssh
// agent holds its key or the agent holds the credential itself. Reading is open to the agent's CLI, which plans
// around the rules; changing either is the owner's alone, since handing over a credential or widening what it may do is
// a decision about the credential rather than a use of it.

export type CredentialPolicyDeps = Pick<Services, "auth" | "credentialPolicy"> & ExtensionHost;

/** Every connected command-line tool's and SSH machine's policy, by capability id; one registry read for the lot. */
export const credentialPolicies = async (
    host: ExtensionHost,
    store: Pick<CredentialPolicyStore, "of">,
): Promise<ReadonlyMap<string, CredentialPolicy>> => {
    const registry = await contributionRegistry(host);
    const policies = new Map<string, CredentialPolicy>();
    for (const card of await host.capabilities.list()) {
        if (card.kind === "ssh") {
            // A key the ssh agent can sign with never reaches the agent; a password, or a key with a passphrase, does.
            const signed = card.config.auth !== "password" && loadPrivateKey(card.config.privateKey) !== undefined;
            policies.set(card.id, { subject: card.id, delivery: signed ? "ssh-agent" : "direct", rules: [], rulesFrom: "connector" });
            continue;
        }
        if (card.kind !== "cli") {
            continue;
        }
        const connector = contributionFor(registry, "cli", card.config);
        if (connector === undefined) {
            continue;
        }
        const broker = brokerOf(connector.spec);
        const owner = await store.of(card.id);
        policies.set(card.id, {
            subject: card.id,
            delivery: broker === undefined ? "direct" : owner.delivery === "raw" ? "raw" : "gateway",
            rules: [...(owner.rules ?? broker?.rules ?? [])],
            rulesFrom: owner.rules === undefined ? "connector" : "owner",
        });
    }
    return policies;
};

export const createCredentialPolicyRoutes = (services: CredentialPolicyDeps) => {
    const i = implement(secretsContract).$context<OrpcContext>();
    const policyOf = async (subject: string): Promise<CredentialPolicy> => {
        const policy = (await credentialPolicies(services, services.credentialPolicy)).get(subject);
        if (policy === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `no connected command-line tool or SSH machine named "${subject}"` });
        }
        return policy;
    };
    return {
        policy: i.policy.handler(async ({ input }) => policyOf(input.subject)),
        setPolicy: i.setPolicy.handler(async ({ input, context }) => {
            // The agent's own token never changes this, whoever's session it rides; only the owner's own request does.
            if (context.headers.get("x-intentic-agent") !== null || !(await isOwnerBearer(services, context.headers))) {
                throw new ORPCError("FORBIDDEN", {
                    message: `Only the owner can change how "${input.subject}"'s credential reaches the agent, or its rules.`,
                });
            }
            const current = await policyOf(input.subject);
            if (current.delivery === "direct" && (input.delivery !== undefined || input.rules !== undefined)) {
                throw new ORPCError("BAD_REQUEST", {
                    message: `"${input.subject}"'s connector has no credential-gateway route, so its credential can only be handed over as it is.`,
                });
            }
            if (current.delivery === "ssh-agent" && (input.delivery !== undefined || input.rules !== undefined)) {
                throw new ORPCError("BAD_REQUEST", {
                    message: `"${input.subject}" is an SSH machine: the sandbox's ssh agent signs with its key, and there are no request rules to set.`,
                });
            }
            if (input.delivery !== undefined) {
                await services.credentialPolicy.setDelivery(input.subject, input.delivery);
            }
            if (input.rules !== undefined) {
                await services.credentialPolicy.setRules(input.subject, input.rules ?? undefined);
            }
            return policyOf(input.subject);
        }),
    };
};
