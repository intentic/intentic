import { OpenAPIHandler } from "@orpc/openapi/fetch";
import { ORPCError } from "@orpc/server";
import { describe, expect, it } from "vitest";
import type { Logger } from "pino";
import type { PrismaClient } from "@intentic-app/prisma";
import type { OrpcContext } from "../context.js";
import { requireAdmin } from "../guards.js";
import { adminOverview } from "./admin-overview.js";
import { adminRoutes } from "./admin.routes.js";
import { adminUsers } from "./admin-users.js";

/* THE ADMIN SURFACE'S WHOLE SECURITY STORY IS ONE GUARD, so the things worth pinning are the refusals: an
 * empty allowlist refusing everyone (a fresh self-hosted platform has no admin surface), a signed-in
 * non-admin reading FORBIDDEN rather than data, and the allowlist matching by address rather than by
 * spelling (case and whitespace are presentation, not identity). */

const contextWith = (emails: string, user: { email: string } | null): OrpcContext =>
    ({ user: user ? { id: `u1`, email: user.email, name: `x`, image: null } : null, config: { admin: { emails } } }) as OrpcContext;

describe(`requireAdmin`, () => {
    it(`refuses an unauthenticated caller with UNAUTHORIZED, before any allowlist reading`, () => {
        expect(() => requireAdmin(contextWith(`radarsu@gmail.com`, null))).toThrowError(
            expect.objectContaining({ code: `UNAUTHORIZED` }) as unknown as ORPCError<string, unknown>,
        );
    });

    it(`refuses everyone when the allowlist is empty — the unconfigured platform has no admin surface`, () => {
        expect(() => requireAdmin(contextWith(``, { email: `radarsu@gmail.com` }))).toThrowError(
            expect.objectContaining({ code: `FORBIDDEN` }) as unknown as ORPCError<string, unknown>,
        );
    });

    it(`refuses a signed-in account that is not on the list`, () => {
        expect(() => requireAdmin(contextWith(`radarsu@gmail.com`, { email: `visitor@example.com` }))).toThrowError(
            expect.objectContaining({ code: `FORBIDDEN` }) as unknown as ORPCError<string, unknown>,
        );
    });

    it(`admits a listed email and returns the session user`, () => {
        expect(requireAdmin(contextWith(`radarsu@gmail.com`, { email: `radarsu@gmail.com` })).email).toBe(`radarsu@gmail.com`);
    });

    it(`matches by address, not by spelling: case-folded on both sides, whitespace trimmed, several entries`, () => {
        const context = contextWith(` Ops@Example.COM , radarsu@gmail.com `, { email: `RADARSU@gmail.com` });
        expect(requireAdmin(context).email).toBe(`RADARSU@gmail.com`);
    });

    it(`does not admit on a stray empty entry (",," never matches the empty string)`, () => {
        expect(() => requireAdmin(contextWith(`,,`, { email: `visitor@example.com` }))).toThrowError(
            expect.objectContaining({ code: `FORBIDDEN` }) as unknown as ORPCError<string, unknown>,
        );
    });
});

describe(`adminOverview`, () => {
    it(`assembles the counts and fills every service status, absent group-by rows included`, async () => {
        const now = new Date(`2026-08-25T10:30:00Z`);
        const captured: { sandboxWheres: unknown[]; membershipWhere?: unknown; runWhere?: unknown } = { sandboxWheres: [] };
        const prisma = {
            user: { count: async () => 7 },
            sandbox: {
                count: async (args?: { where?: unknown }) => {
                    captured.sandboxWheres.push(args?.where);
                    return args?.where ? 3 : 9;
                },
            },
            membership: {
                count: async (args: { where: unknown }) => {
                    captured.membershipWhere = args.where;
                    return 2;
                },
            },
            service: {
                groupBy: async () => [
                    { status: `listed`, _count: { _all: 4 } },
                    { status: `suspended`, _count: { _all: 1 } },
                ],
            },
            serviceRun: {
                count: async (args: { where: unknown }) => {
                    captured.runWhere = args.where;
                    return 11;
                },
            },
            hostedMachine: { count: async () => 5 },
        } as unknown as PrismaClient;

        const overview = await adminOverview(prisma, () => now);
        expect(overview).toEqual({
            users: 7,
            sandboxes: 9,
            activeDaemons: 3,
            activeMemberships: 2,
            services: { draft: 0, probation: 0, listed: 4, suspended: 1 },
            runsToday: 11,
            hostedMachines: 5,
        });
        // The active window is five minutes back from "now", and today starts at UTC midnight.
        expect(captured.sandboxWheres).toContainEqual({ lastSeenAt: { gte: new Date(`2026-08-25T10:25:00Z`) } });
        expect(captured.runWhere).toEqual({ createdAt: { gte: new Date(`2026-08-25T00:00:00Z`) } });
        // The premium rule verbatim: active + trialing, never past_due.
        expect(captured.membershipWhere).toEqual({ status: { in: [`active`, `trialing`] } });
    });
});

describe(`adminUsers`, () => {
    const row = (id: string, extra?: { membership?: { status: string } | null; sandboxes?: number }) => ({
        id,
        email: `${id}@example.com`,
        name: `User ${id}`,
        image: null,
        createdAt: new Date(`2026-08-01T00:00:00Z`),
        membership: extra?.membership ?? null,
        _count: { sandboxes: extra?.sandboxes ?? 0 },
    });

    const prismaWith = (rows: ReturnType<typeof row>[], total: number, captured: { findArgs?: Record<string, unknown>; countArgs?: unknown }) =>
        ({
            user: {
                findMany: async (args: Record<string, unknown>) => {
                    captured.findArgs = args;
                    return rows;
                },
                count: async (args: unknown) => {
                    captured.countArgs = args;
                    return total;
                },
            },
        }) as unknown as PrismaClient;

    it(`maps rows to the wire shape: ISO createdAt, sandbox count, membership status only when one exists`, async () => {
        const captured: { findArgs?: Record<string, unknown> } = {};
        const prisma = prismaWith([row(`a`, { membership: { status: `active` }, sandboxes: 2 }), row(`b`)], 2, captured);
        const result = await adminUsers(prisma, { limit: 50 });
        expect(result).toEqual({
            total: 2,
            users: [
                {
                    id: `a`,
                    email: `a@example.com`,
                    name: `User a`,
                    image: null,
                    createdAt: `2026-08-01T00:00:00.000Z`,
                    sandboxCount: 2,
                    membershipStatus: `active`,
                },
                { id: `b`, email: `b@example.com`, name: `User b`, image: null, createdAt: `2026-08-01T00:00:00.000Z`, sandboxCount: 0 },
            ],
        });
        // No overflow row came back, so there is no next page and no cursor.
        expect(result.nextCursor).toBeUndefined();
    });

    it(`pages by one-row overflow: limit rows returned, nextCursor names the last RENDERED row`, async () => {
        const captured = {};
        const prisma = prismaWith([row(`a`), row(`b`), row(`c`)], 10, captured);
        const result = await adminUsers(prisma, { limit: 2 });
        expect(result.users.map((user) => user.id)).toEqual([`a`, `b`]);
        expect(result.nextCursor).toBe(`b`);
    });

    it(`passes the cursor through as an exclusive boundary (skip 1) and asks for limit+1 rows`, async () => {
        const captured: { findArgs?: Record<string, unknown> } = {};
        await adminUsers(prismaWith([], 0, captured), { limit: 2, cursor: `b` });
        expect(captured.findArgs).toMatchObject({ take: 3, cursor: { id: `b` }, skip: 1 });
    });

    it(`filters email OR name case-insensitively, and the SAME filter feeds the total`, async () => {
        const captured: { findArgs?: Record<string, unknown>; countArgs?: unknown } = {};
        await adminUsers(prismaWith([], 0, captured), { limit: 50, query: `  Radarsu ` });
        const where = {
            OR: [
                { email: { contains: `Radarsu`, mode: `insensitive` } },
                { name: { contains: `Radarsu`, mode: `insensitive` } },
            ],
        };
        expect(captured.findArgs?.[`where`]).toEqual(where);
        expect(captured.countArgs).toEqual({ where });
    });
});

/* THE WIRE, NOT JUST THE FUNCTIONS. The panel is a plain `fetch` against the OpenAPI surface — a GET whose
 * input arrives as query-string strings — so what is worth pinning here is the whole path through the same
 * OpenAPIHandler app.ts mounts: query params parsed and coerced into the contract input, the guard answering
 * 403 as an HTTP status, and the audit line written with the caller's email. */
describe(`admin over the OpenAPI wire`, () => {
    const logLines: unknown[] = [];
    const logger = { info: (fields: unknown) => logLines.push(fields), warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

    const serve = async (url: string, user: { email: string } | null, prisma: PrismaClient) => {
        const handler = new OpenAPIHandler({ admin: adminRoutes });
        const context = {
            prisma,
            config: { admin: { emails: `radarsu@gmail.com` } },
            user: user ? { id: `u1`, email: user.email, name: `x`, image: null } : null,
            logger,
        } as unknown as OrpcContext;
        const result = await handler.handle(new Request(`http://api.test${url}`), { context, prefix: `/rpc` });
        if (!result.matched) {
            throw new Error(`route did not match`);
        }
        return result.response;
    };

    it(`parses ?limit=&query= off the query string, coerces limit, and answers the page as JSON`, async () => {
        let findArgs: Record<string, unknown> | undefined;
        const prisma = {
            user: {
                findMany: async (args: Record<string, unknown>) => {
                    findArgs = args;
                    return [];
                },
                count: async () => 0,
            },
        } as unknown as PrismaClient;
        const response = await serve(`/rpc/admin/users?limit=2&query=radar`, { email: `radarsu@gmail.com` }, prisma);
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ users: [], total: 0 });
        // limit=2 arrived as a string and reached the query as the number 3 (limit + the overflow row).
        expect(findArgs).toMatchObject({ take: 3 });
        // The audit line names who asked for what.
        expect(logLines).toContainEqual({ admin: `radarsu@gmail.com`, route: `admin.users` });
    });

    it(`answers 403 to a signed-in non-admin and 401 to no session, as HTTP statuses the panel reads`, async () => {
        const prisma = {} as PrismaClient;
        expect((await serve(`/rpc/admin/overview`, { email: `visitor@example.com` }, prisma)).status).toBe(403);
        expect((await serve(`/rpc/admin/overview`, null, prisma)).status).toBe(401);
    });
});
