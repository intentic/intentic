import { safetyContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

/* The Safety page's two reads and its one write: the policy document, and the log of what it decided.
 *
 * `setPolicy` does NOT validate the text, and that is the design rather than an omission. There is no shape for
 * a policy to be wrong in — its reader is a model, not a parser — so the only thing a check here could do is
 * refuse prose somebody meant. What bounds the damage is not validation but what the document GOVERNS: nothing
 * written here can widen a machine's scopes, unfence the JS runtime or reach outside the container (the
 * contract's safety-policy.ts sets that out). An empty policy is a sandbox that asks about the hard rule and
 * nothing else, which is a posture an owner is entitled to choose.
 */
export const createSafetyRoutes = (services: Pick<Services, "safetyPolicy" | "safetyLog">) => {
    const i = implement(safetyContract).$context<OrpcContext>();
    return {
        policy: i.policy.handler(() => services.safetyPolicy.get()),
        setPolicy: i.setPolicy.handler(async ({ input }) => {
            await services.safetyPolicy.set(input.text);
            return { ok: true } as const;
        }),
        log: i.log.handler(() => services.safetyLog.recent()),
    };
};
