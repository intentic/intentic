import type { AdminUserList } from "@intentic-app/api-contract";
import type { Prisma, PrismaClient } from "@intentic-app/prisma";

export interface AdminUsersInput {
    readonly query?: string;
    readonly cursor?: string;
    readonly limit: number;
}

/* The account directory, newest first, cursor-paged on the row id (unique, so the page boundary is exact
 * even when several accounts share a createdAt). Counts ride each row via `_count` rather than a per-row
 * query, and the same filter feeds the list and the total so the two can never describe different sets.
 * Nothing selected here is a secret — the GDPR export already shows every subject strictly more about
 * themselves than this row tells the operator. */
export const adminUsers = async (prisma: PrismaClient, input: AdminUsersInput): Promise<AdminUserList> => {
    const query = input.query?.trim();
    const where: Prisma.UserWhereInput | undefined = query
        ? {
              OR: [
                  { email: { contains: query, mode: `insensitive` } },
                  { name: { contains: query, mode: `insensitive` } },
              ],
          }
        : undefined;
    const [rows, total] = await Promise.all([
        prisma.user.findMany({
            where,
            orderBy: [{ createdAt: `desc` }, { id: `desc` }],
            // One row past the page: its presence is the whole "is there a next page" answer, and it is
            // dropped before anything renders.
            take: input.limit + 1,
            ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
            select: {
                id: true,
                email: true,
                name: true,
                image: true,
                createdAt: true,
                membership: { select: { status: true } },
                _count: { select: { sandboxes: true } },
            },
        }),
        prisma.user.count({ where }),
    ]);
    const page = rows.slice(0, input.limit);
    return {
        users: page.map((row) => ({
            id: row.id,
            email: row.email,
            name: row.name,
            image: row.image,
            createdAt: row.createdAt.toISOString(),
            sandboxCount: row._count.sandboxes,
            ...(row.membership ? { membershipStatus: row.membership.status } : {}),
        })),
        total,
        ...(rows.length > input.limit ? { nextCursor: page[page.length - 1]!.id } : {}),
    };
};
