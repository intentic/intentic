import { usageContract } from "@intentic/sandbox-contract/contracts/usage.contract";
import { implement, ORPCError } from "@orpc/server";
import { claimAndSettle, readLimitReset } from "../runtimes/claude/claude-limit-reset.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { opt } from "../opt.js";
import { accountReachAllows } from "../secrets/credential-reach.js";
import { capacitySnapshot, placementOf } from "./serviceability/capacity-feed.js";
import type { ServiceabilityDeps } from "./serviceability/serviceability.js";

export type UsageRoutesDeps = Pick<Services, "accountReach" | "headroom" | "usage" | "claudeStore" | "providerRefusals"> & ServiceabilityDeps;

// How long a forced re-measure waits for the sweep before returning the stale reading; bounded by the readers' own
// timeouts.
const FORCED_WAIT_MS = 9_000;
// An unforced call is a screen arriving, and it wants `held` more than it wants a landed read: the sweep it triggers is
// held to every target's own budget anyway, so waiting the forced wait would only delay the panel.
const ARRIVAL_WAIT_MS = 1_500;

// The store keys a routed account by `${provider}:${file}` and a native one by its id; over the wire an account is
// always named the way its provider's list names it, since that is what a caller has in hand to match against.
const listedAccount = (provider: string, key: string): string => (key.startsWith(`${provider}:`) ? key.slice(provider.length + 1) : key);

// The spend ledger's read side; rows are appended daemon-side at turn end, so this stays read-only.
export const createUsageRoutes = (services: UsageRoutesDeps) => {
    const i = implement(usageContract).$context<OrpcContext>();
    return {
        rollup: i.rollup.handler(async ({ input }) => ({ rows: await services.usage.rollup(input) })),
        refreshPlanLimits: i.refreshPlanLimits.handler(async ({ input }) => {
            await services.headroom.refresh({
                // Only a forced press is watched, and only a watched sweep may spend a target's own read budget early.
                ...(input.force ? { maxAgeMs: 0, watched: true } : {}),
                withinMs: input.force ? FORCED_WAIT_MS : ARRIVAL_WAIT_MS,
            });
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
        // Judged now, by the same rule and the same ports the pushed capacity is (capacity-feed.ts).
        capacity: i.capacity.handler(async () => capacitySnapshot(services)),
        /* The turn the asker would send: on the loop they named, among the AI accounts they may run on (Access ▸ People,
           read as a turn of theirs is held to it, account-reach.ts; the owner's own tools and a caller with no member
           identity reach every account). 2026-11-19: its first form answered the sandbox-wide pick on the default loop,
           and a window whose rows left that account out predicted its own pick instead, which the turn's could differ
           from; a window narrowing the daemon's answer itself was rejected, since only the daemon counts the load. */
        placement: i.placement.handler(async ({ input, context }) => {
            const judgedAt = Date.now();
            const asker = context.identity?.email;
            const reach = await services.accountReach(undefined, asker === undefined ? [] : [asker]);
            const account = await placementOf(input.provider, input.model === "" ? undefined : input.model, {
                loop: input.loop,
                allows: (id) => accountReachAllows(reach, input.provider, id),
            });
            return { judgedAt, ...opt("account", account), narrowed: true as const };
        }),
/* A spent session window can continue through the Claude reset mechanism. */
        limitReset: i.limitReset.handler(async ({ input }) => {
            const status = await readLimitReset({ store: services.claudeStore, headroom: services.headroom }, input.account);
            if (status === undefined) {
                throw new ORPCError("SERVICE_UNAVAILABLE", { message: "The provider could not check reset availability. Try again in a moment." });
            }
            return status;
        }),
        // A reset that went through takes back the refusal the records still hold against the window (claimAndSettle).
        claimLimitReset: i.claimLimitReset.handler(async ({ input }) =>
            claimAndSettle({ store: services.claudeStore, headroom: services.headroom, refusals: services.providerRefusals }, input.account),
        ),
    };
};
