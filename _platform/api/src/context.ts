import type { User } from "@intentic-app/api-contract";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";

// Per-request context handed to every oRPC handler: the shared PrismaClient client, the loaded config, the resolved
// session user (null when unauthenticated), and the request-scoped logger (correlated by requestId).
//
// `auth` and `headers` ride along for the one route that needs Better Auth itself rather than the resolved
// user, the desktop handoff mints a one-time token FOR THE CALLER'S SESSION, which means handing Better Auth
// the same headers this context was resolved from. `sessionHeaders` carries Better Auth's refreshed cookie
// back through the oRPC response instead of updating the database while leaving the browser's cookie stale.
export interface OrpcContext {
    prisma: PrismaClient;
    config: Config;
    user: User | null;
    logger: Logger;
    auth: Auth;
    headers: Headers;
    sessionHeaders: Headers;
}

export const buildOrpcContext = async (
    deps: { auth: Auth; prisma: PrismaClient; config: Config; logger: Logger },
    headers: Headers,
): Promise<OrpcContext> => {
    const { response: session, headers: sessionHeaders } = await deps.auth.api.getSession({ headers, returnHeaders: true });
    const user: User | null = session
        ? { id: session.user.id, email: session.user.email, name: session.user.name, image: session.user.image ?? null }
        : null;
    return { prisma: deps.prisma, config: deps.config, user, logger: deps.logger, auth: deps.auth, headers, sessionHeaders };
};
