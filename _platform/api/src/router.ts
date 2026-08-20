import { creatorRoutes } from "./creator/creator.orpc.js";
import { desktopRoutes } from "./desktop/desktop.routes.js";
import { inviteRoutes } from "./invite/invite.routes.js";
import { meRoutes } from "./me/me.routes.js";
import { poolRoutes } from "./pool/pool.orpc.js";
import { pushRelayRoutes } from "./push-relay/push-relay.routes.js";
import { sandboxRoutes } from "./sandbox/sandbox.routes.js";

// The implemented oRPC router, the per-domain route objects assembled into the apiContract shape. The
// OpenAPIHandler in app.ts serves it. Each domain's handlers, logic, and tests live in its own folder.
export const router = {
    me: meRoutes,
    sandbox: sandboxRoutes,
    invite: inviteRoutes,
    desktop: desktopRoutes,
    pool: poolRoutes(),
    creator: creatorRoutes(),
    push: pushRelayRoutes(),
};
