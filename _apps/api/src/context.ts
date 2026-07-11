import type { User } from "@intentic-app/api-contract";
import type { Auth } from "./auth.js";
import type { Config } from "./config.js";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";

// Per-request context handed to every oRPC handler: the shared PrismaClient client, the loaded config, the resolved
// session user (null when unauthenticated), and the request-scoped logger (correlated by requestId).
export interface OrpcContext {
    prisma: PrismaClient;
    config: Config;
    user: User | null;
    logger: Logger;
}

export const buildOrpcContext = async (
    deps: { auth: Auth; prisma: PrismaClient; config: Config; logger: Logger },
    headers: Headers,
): Promise<OrpcContext> => {
    const session = await deps.auth.api.getSession({ headers });
    const user: User | null = session
        ? { id: session.user.id, email: session.user.email, name: session.user.name, image: session.user.image ?? null }
        : null;
    return { prisma: deps.prisma, config: deps.config, user, logger: deps.logger };
};
