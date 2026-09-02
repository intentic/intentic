import { usageContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

export type UsageRoutesDeps = Pick<Services, "headroom" | "usage">;

// How long a forced re-measure waits for the sweep: somebody is watching a spinner they started, so giving up
// early would answer the question with the stale number the press was doubting. Bounded by the readers' own
// timeouts, past which there is nothing left to wait for.
const FORCED_WAIT_MS = 9_000;

// The spend ledger's read side. Read-only by design, rows are appended daemon-side at turn end, so the ledger
// stays a trustworthy record of what was spent (the activity log's principle, applied to money).
export const createUsageRoutes = (services: UsageRoutesDeps) => {
    const i = implement(usageContract).$context<OrpcContext>();
    return {
        rollup: i.rollup.handler(async ({ input }) => ({ rows: await services.usage.rollup(input) })),
        refreshPlanLimits: i.refreshPlanLimits.handler(async ({ input }) => {
            await services.headroom.refresh({ ...(input.force ? { maxAgeMs: 0 } : {}), withinMs: FORCED_WAIT_MS });
            return { ok: true } as const;
        }),
    };
};
