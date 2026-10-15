import { orgContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Config } from "../env.config.js";
import { callIngress } from "../system/platform-client.js";
import type { OrgPolicyFetch, OrgPolicyHolder } from "./org-policy.js";

// The editor's read of the policy this daemon enforces (GET /org/policy): unbound, or the edition held and when it came.
export const createOrgRoutes = (services: { readonly orgPolicy: OrgPolicyHolder }) => {
    const i = implement(orgContract).$context<OrpcContext>();
    return {
        policy: i.policy.handler(() => services.orgPolicy.state()),
    };
};

// Asks the platform this sandbox is registered with, over its connect token. Only a 200 is an answer; anything else is
// undefined, which the holder reads as "keep what is held".
export const platformOrgPolicyFetch =
    (config: Config): OrgPolicyFetch =>
    async (applied, signal) => {
        const answer = await callIngress(config, { route: "orgPolicy", input: applied === undefined ? {} : { applied }, signal });
        return answer.status === 200 ? answer.data : undefined;
    };
