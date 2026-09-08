import { usageContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { claimLimitReset, readLimitReset } from "./claude-limit-reset.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";

export type UsageRoutesDeps = Pick<Services, "headroom" | "usage" | "claudeStore">;

// How long a forced re-measure waits for the sweep before returning the stale reading; bounded by the readers' own
// timeouts.
const FORCED_WAIT_MS = 9_000;

// The spend ledger's read side; rows are appended daemon-side at turn end, so this stays read-only.
export const createUsageRoutes = (services: UsageRoutesDeps) => {
    const i = implement(usageContract).$context<OrpcContext>();
    return {
        rollup: i.rollup.handler(async ({ input }) => ({ rows: await services.usage.rollup(input) })),
        refreshPlanLimits: i.refreshPlanLimits.handler(async ({ input }) => {
            await services.headroom.refresh({ ...(input.force ? { maxAgeMs: 0 } : {}), withinMs: FORCED_WAIT_MS });
            return { ok: true } as const;
        }),
        /* The way past a spent session window that is not waiting for it (claude-limit-reset.ts next door holds
         * the whole mechanism, and why the probe is asked rather than polled).
         *
         * Claude's store answers for an account it does not hold exactly as it answers for one with no grant:
         * nothing available. So a caller may ask about any account it can name without first working out which
         * provider grants one, and no provider needs a row here until it grows the same idea. */
        limitReset: i.limitReset.handler(async ({ input }) => {
            const status = await readLimitReset(services.claudeStore, input.account);
            if (status === undefined) {
                throw new ORPCError("SERVICE_UNAVAILABLE", { message: "The provider could not check reset availability. Try again in a moment." });
            }
            return status;
        }),
        claimLimitReset: i.claimLimitReset.handler(async ({ input }) => claimLimitReset(services.claudeStore, input.account)),
    };
};
