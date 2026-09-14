import { safetyContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";

/* The Safety page's two reads and its one write: the policy document, and the log of what it decided. */
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
