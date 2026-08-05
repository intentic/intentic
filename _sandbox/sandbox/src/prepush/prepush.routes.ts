import { prepushContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";

import type { OrpcContext } from "../context.js";
import { type PrepushDeps, prepushCheck } from "./prepush.js";

export type PrepushRoutesDeps = PrepushDeps;

// The pre-push check's owner-facing surface — the push dialog's three verbs. Each addresses the ONE check this
// process has (prepush/prepush.ts), so none of them takes an id.
//
// `run` answers as soon as the child EXISTS, not when the suite finishes: a suite takes minutes, and an oRPC
// call held open for one would die on the first proxy timeout with the check still going. Awaiting that much is
// what makes the caller's first `state` poll — fired the instant this returns — see the run rather than the
// `idle` that preceded it.
export const createPrepushRoutes = (services: PrepushRoutesDeps) => {
    const i = implement(prepushContract).$context<OrpcContext>();
    const check = prepushCheck(services);
    return {
        state: i.state.handler(() => check.state()),
        run: i.run.handler(async () => {
            await check.run();
            return { ok: true as const };
        }),
        // Cancelling a check that has already settled is not an error — the kill finds no pid and does nothing,
        // which is what makes a stale click on a dialog the user has since resolved harmless.
        cancel: i.cancel.handler(() => {
            check.cancel();
            return { ok: true as const };
        }),
    };
};
