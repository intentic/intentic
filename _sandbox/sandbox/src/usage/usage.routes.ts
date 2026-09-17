import { usageContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { claimLimitReset, readLimitReset } from "./claude-limit-reset.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";

export type UsageRoutesDeps = Pick<Services, "headroom" | "usage" | "claudeStore">;

// How long a forced re-measure waits for the sweep before returning the stale reading; bounded by the readers' own
// timeouts.
const FORCED_WAIT_MS = 9_000;

// The store keys a routed account by `${provider}:${file}` and a native one by its id; over the wire an account is
// always named the way its provider's list names it, since that is what a caller has in hand to match against.
const listedAccount = (provider: string, key: string): string => (key.startsWith(`${provider}:`) ? key.slice(provider.length + 1) : key);

// The spend ledger's read side; rows are appended daemon-side at turn end, so this stays read-only.
export const createUsageRoutes = (services: UsageRoutesDeps) => {
    const i = implement(usageContract).$context<OrpcContext>();
    return {
        rollup: i.rollup.handler(async ({ input }) => ({ rows: await services.usage.rollup(input) })),
        refreshPlanLimits: i.refreshPlanLimits.handler(async ({ input }) => {
            await services.headroom.refresh({ ...(input.force ? { maxAgeMs: 0 } : {}), withinMs: FORCED_WAIT_MS });
            // Reported in seconds like every other instant on the wire, so a caller can say when the number can move.
            return {
                ok: true as const,
                held: services.headroom.held().map((entry) => ({
                    provider: entry.provider,
                    account: listedAccount(entry.provider, entry.account),
                    resumesAt: Math.ceil(entry.until / 1000),
                })),
            };
        }),
/* A spent session window can continue through the Claude reset mechanism. */
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
