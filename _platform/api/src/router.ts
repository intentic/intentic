import type { apiContract } from "@intentic/api-contract";
import type { Router } from "@orpc/server";
import { adminRoutes } from "./admin/admin.routes.js";
import { desktopRoutes } from "./desktop/desktop.routes.js";
import { inviteRoutes } from "./invite/invite.routes.js";
import { meRoutes } from "./me/me.routes.js";
import { pushRelayRoutes } from "./push-relay/push-relay.routes.js";
import { hostedPlanRoutes } from "./sandbox/hosted/plan/hosted-plan.orpc.js";
import { sandboxRoutes } from "./sandbox/sandbox.routes.js";
import { tokenRoutes } from "./tokens/tokens.routes.js";
import type { OrpcContext } from "./context.js";
import { walletRoutes } from "./wallet/wallet.orpc.js";

// The implemented oRPC router, the per-domain route objects assembled into the apiContract shape. The
// OpenAPIHandler in app.ts serves it. Each domain's handlers, logic, and tests live in its own folder. Typed by the
// contract it implements rather than inferred, so a procedure the contract declares and no domain serves fails the
// compile here instead of answering 404 at runtime.
export type ApiRouter = Router<typeof apiContract, OrpcContext>;

export const router: ApiRouter = {
    me: meRoutes,
    token: tokenRoutes,
    sandbox: sandboxRoutes,
    invite: inviteRoutes,
    desktop: desktopRoutes,
    hostedPlan: hostedPlanRoutes(),
    push: pushRelayRoutes(),
    wallet: walletRoutes(),
    admin: adminRoutes,
};
