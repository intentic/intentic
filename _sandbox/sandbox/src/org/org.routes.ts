import { orgContract } from "@intentic/sandbox-contract/contracts/org.contract";
import { implement } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { OrgPolicyHolder } from "./org-policy.js";

// The editor's read of the policy this daemon enforces (GET /org/policy): unbound, or the edition held and when it came.
export const createOrgRoutes = (services: { readonly orgPolicy: OrgPolicyHolder }) => {
    const i = implement(orgContract).$context<OrpcContext>();
    return {
        policy: i.policy.handler(() => services.orgPolicy.state()),
    };
};
