import type { Config } from "../env.config.js";
import type { OrgPolicyFetch } from "../org/org-policy.js";
import { callIngress } from "./platform-client.js";

// Asks the platform this sandbox is registered with, over its connect token. Only a 200 is an answer; anything else is
// undefined, which the holder reads as "keep what is held".
export const platformOrgPolicyFetch =
    (config: Config): OrgPolicyFetch =>
    async (applied, signal) => {
        const answer = await callIngress(config, { route: "orgPolicy", input: applied === undefined ? {} : { applied }, signal });
        return answer.status === 200 ? answer.data : undefined;
    };
