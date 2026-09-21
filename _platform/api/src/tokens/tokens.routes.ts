import { type ApiToken, apiContract } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { implement, ORPCError } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { apiTokenDigest, type ApiTokenScope, mintApiToken } from "./api-tokens.js";

const os = implement(apiContract).$context<OrpcContext>();

// How many live tokens one account may hold. Not a business limit — a bound on how much damage one forgotten page of
// tokens can do, and a nudge to revoke rather than accumulate.
const TOKEN_CEILING = 20;

// The list is the page's whole state, so every mutation answers with it: a revoke that raced another tab still leaves
// both showing the same tokens.
const listFor = async (prisma: PrismaClient, userId: string): Promise<ApiToken[]> => {
    const rows = await prisma.apiToken.findMany({
        where: { userId, revokedAt: null },
        select: { id: true, label: true, scope: true, createdAt: true, lastUsedAt: true },
        orderBy: { createdAt: `desc` },
    });
    return rows.map((row) => ({
        id: row.id,
        label: row.label,
        // Widened at rest (a scope is a value, not a migration), narrowed here against the contract the page reads.
        scope: row.scope as ApiTokenScope,
        createdAt: row.createdAt.toISOString(),
        ...(row.lastUsedAt === null ? {} : { lastUsedAt: row.lastUsedAt.toISOString() }),
    }));
};

export const tokenRoutes = {
    list: os.token.list.handler(async ({ context }) => {
        const user = requireUser(context);
        return { tokens: await listFor(context.prisma, user.id) };
    }),
    // A SESSION mints, always: a token that could mint its successor would outlive every revoke, since revoking the
    // one you know about would leave the one it made.
    create: os.token.create.handler(async ({ context, input }) => {
        const user = requireUser(context);
        const live = await context.prisma.apiToken.count({ where: { userId: user.id, revokedAt: null } });
        if (live >= TOKEN_CEILING) {
            throw new ORPCError(`TOO_MANY_REQUESTS`, { message: `you already hold ${TOKEN_CEILING} tokens; revoke one before making another` });
        }
        const token = mintApiToken();
        const row = await context.prisma.apiToken.create({
            data: { userId: user.id, label: input.label.trim(), hash: apiTokenDigest(token), scope: input.scope },
            select: { id: true, label: true, scope: true, createdAt: true },
        });
        // The one moment the raw value exists outside the holder's hands. Nothing stores it; nothing can return it again.
        return { id: row.id, label: row.label, scope: input.scope, createdAt: row.createdAt.toISOString(), token };
    }),
    // Scoped by userId in the same write, so a guessed id belonging to someone else updates nothing rather than
    // answering differently from one that does not exist.
    revoke: os.token.revoke.handler(async ({ context, input }) => {
        const user = requireUser(context);
        await context.prisma.apiToken.updateMany({
            where: { id: input.tokenId, userId: user.id, revokedAt: null },
            data: { revokedAt: new Date() },
        });
        return { tokens: await listFor(context.prisma, user.id) };
    }),
};
