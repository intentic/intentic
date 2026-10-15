import { orgLockRefusal, sandboxRouteFor } from "@intentic/sandbox-contract";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../app-env.js";
import type { OrgPolicyHolder } from "./org-policy.js";

// An organisation's locks (org-policy.ts, sandbox-contract policy/org-locks.ts), mounted by app.ts after
// authentication, for every credential alike: the owner, a member, the agent's token, a panel or a control token. A
// lock is lifted by changing the organisation's policy on the platform, never from inside the sandbox. A personal
// sandbox holds no policy and passes after one await.
export const orgLocks =
    (holder: OrgPolicyHolder): MiddlewareHandler<AppEnv> =>
    async (c, next) => {
        const policy = await holder.current();
        if (policy === undefined) {
            return next();
        }
        const path = c.req.path.replace(/\/+$/u, "") || "/";
        const refused = orgLockRefusal(policy, sandboxRouteFor(c.req.method, path)?.name);
        return refused === undefined ? next() : c.json(refused, 403);
    };
