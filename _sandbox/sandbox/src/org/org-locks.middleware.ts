import { orgLockRefusal, orgSectionOfRoute, sandboxRouteFor } from "@intentic/sandbox-contract";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.js";
import { ORG_POLICY_FIRST_ANSWER_MS, type OrgPolicyHolder } from "./org-policy.js";

// An organisation's locks (org-policy.ts, sandbox-contract policy/org-locks.ts), mounted by app.ts after
// authentication, for every credential alike: the owner, a member, the agent's token, a panel or a control token. A
// lock is lifted by changing the organisation's policy on the platform, never from inside the sandbox. A personal
// sandbox holds no policy and passes after one await, except for a request a lock could cover that arrives while the
// platform's first answer since boot is still out: that one waits for it (bounded), so a bound sandbox whose held file
// was deleted does not answer its first changes as a personal one.
export const orgLocks =
    (holder: OrgPolicyHolder): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
        let policy = await holder.current();
        const routeName = (): string | undefined => sandboxRouteFor(c.req.method, c.req.path.replace(/\/+$/u, "") || "/")?.name;
        if (policy === undefined) {
            if (!holder.waiting()) {
                return next();
            }
            const name = routeName();
            if (name === undefined || orgSectionOfRoute(name) === undefined) {
                return next();
            }
            await holder.settled(ORG_POLICY_FIRST_ANSWER_MS);
            policy = await holder.current();
            if (policy === undefined) {
                return next();
            }
        }
        const refused = orgLockRefusal(policy, routeName());
        return refused === undefined ? next() : c.json(refused, 403);
    };
