import { prepushContract } from "@intentic/sandbox-contract";
import { implement } from "@orpc/server";

import type { OrpcContext } from "../app-env.js";
import { type PrepushDeps, prepushCheck } from "./prepush.js";

export type PrepushRoutesDeps = PrepushDeps;

// The pre-push check's owner-facing surface, the push dialog's three verbs. Each addresses the ONE check this
// process has (prepush/prepush.ts), so none of them takes an id.
//
// `run` answers as soon as the command is UNDER WAY, not when the suite finishes: a suite takes minutes, and an
// oRPC call held open for one would die on the first proxy timeout with the check still going. Awaiting that much
// is what makes the caller's first `state` poll, fired the instant this returns, see the run, and the terminal
// it is running in, rather than the `idle` that preceded it.
export const createPrepushRoutes = (services: PrepushRoutesDeps) => {
    const i = implement(prepushContract).$context<OrpcContext>();
    const check = prepushCheck(services);
    return {
        state: i.state.handler(() => check.state()),
        // The repositories going out travel with the press: what stands before a push is not the same for every
        // repository in the workspace, and only the caller knows which ones this push is about.
        run: i.run.handler(async ({ input }) => {
            await check.run(input.repos);
            return { ok: true as const };
        }),
        // Cancelling a check that has already settled is not an error, the kill finds no pid and does nothing,
        // which is what makes a stale click on a dialog the user has since resolved harmless.
        cancel: i.cancel.handler(() => {
            check.cancel();
            return { ok: true as const };
        }),
    };
};
