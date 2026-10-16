import type { User } from "@intentic/api-contract";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic/prisma";

// Per-request context handed to every oRPC handler: the shared PrismaClient client, the loaded config, the resolved
// session user (null when unauthenticated), and the request-scoped logger (correlated by requestId).
//
// `auth` and `headers` ride along for the one route that needs Better Auth itself rather than the resolved
// user, the desktop handoff mints a one-time token FOR THE CALLER'S SESSION, which means handing Better Auth
// the same headers this context was resolved from. `sessionHeaders` carries Better Auth's refreshed cookie
// back through the oRPC response instead of updating the database while leaving the browser's cookie stale.
// The signed-in caller as a handler reads them: the account, and whether its address was proven (Google said so, or a
// mailed code was spent). Who may administer, be comped, or be vouched for to a sandbox reads `emailVerified`.
export type SessionUser = User & { readonly emailVerified: boolean };

export interface OrpcContext {
    prisma: PrismaClient;
    config: Config;
    user: SessionUser | null;
    logger: Logger;
    auth: Auth;
    headers: Headers;
    sessionHeaders: Headers;
}

// When the account was made, for the app's sign-up milestone (User.createdAt); left out when the session does not carry
// a readable date, rather than failing the request over an analytics field.
const createdAtOf = (value: Date | string | undefined): { createdAt?: string } => {
    const at = value === undefined ? Number.NaN : new Date(value).getTime();
    return Number.isNaN(at) ? {} : { createdAt: new Date(at).toISOString() };
};

export const buildOrpcContext = async (
    deps: { auth: Auth; prisma: PrismaClient; config: Config; logger: Logger },
    headers: Headers,
): Promise<OrpcContext> => {
    const { response: session, headers: sessionHeaders } = await deps.auth.api.getSession({ headers, returnHeaders: true });
    const user: SessionUser | null = session
        ? {
              id: session.user.id,
              email: session.user.email,
              name: session.user.name,
              image: session.user.image ?? null,
              ...createdAtOf(session.user.createdAt),
              emailVerified: session.user.emailVerified,
          }
        : null;
    return { prisma: deps.prisma, config: deps.config, user, logger: deps.logger, auth: deps.auth, headers, sessionHeaders };
};
