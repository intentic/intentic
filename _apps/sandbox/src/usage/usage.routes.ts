import { usageContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";

// The spend ledger's read side. Read-only by design — rows are appended daemon-side at turn end, so the ledger
// stays a trustworthy record of what was spent (the activity log's principle, applied to money).
export const createUsageRoutes = (services: Services) => {
    const i = implement(usageContract).$context<OrpcContext>();
    return {
        rollup: i.rollup.handler(async ({ input }) => ({ rows: await services.usage.rollup(input) })),
    };
};
