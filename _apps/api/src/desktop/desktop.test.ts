import { call, ORPCError } from "@orpc/server";
import { describe, expect, it, vi } from "vitest";
import type { OrpcContext } from "../context.js";
import { desktopRoutes } from "./desktop.routes.js";

/* The handoff's two guarantees, which are the only things about it worth testing: a redeem SPENDS the row
 * (so a replayed link is inert), and an expired row is refused with the same answer an unknown one gets. The
 * encryption round-trip is crypto.ts's own test; with no SECRETS_KEY it is the identity, which is what makes
 * the assertions here readable. */

const user = { id: `u1`, email: `owner@example.com`, name: `Owner`, image: null };

const fakePrisma = (overrides: Record<string, Record<string, ReturnType<typeof vi.fn>>>) => overrides as unknown as OrpcContext[`prisma`];

const context = (overrides?: Partial<OrpcContext>): OrpcContext =>
    ({
        prisma: fakePrisma({}),
        config: { secrets: { key: `` } },
        user,
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
        auth: { api: { generateOneTimeToken: vi.fn().mockResolvedValue({ token: `ott-1` }) } },
        headers: new Headers(),
        ...overrides,
    }) as OrpcContext;

const row = (expiresAt: Date) => ({ id: `h1`, ott: `ott-1`, idToken: `google-jwt`, expiresAt, createdAt: new Date() });

describe(`desktop handoff`, () => {
    it(`mints a one-time token for the caller's own session`, async () => {
        const create = vi.fn().mockResolvedValue({ id: `h1` });
        const generateOneTimeToken = vi.fn().mockResolvedValue({ token: `ott-1` });
        const headers = new Headers({ cookie: `session=abc` });
        const ctx = context({
            prisma: fakePrisma({ desktopHandoff: { create } }),
            auth: { api: { generateOneTimeToken } } as unknown as OrpcContext[`auth`],
            headers,
        });

        await expect(call(desktopRoutes.handoff, { idToken: `google-jwt` }, { context: ctx })).resolves.toEqual({ handoff: `h1` });
        // The caller's OWN headers, not a fresh request: the token has to belong to the session that asked.
        expect(generateOneTimeToken).toHaveBeenCalledWith({ headers });
        expect(create.mock.calls[0]?.[0]?.data).toMatchObject({ ott: `ott-1`, idToken: `google-jwt` });
    });

    it(`refuses to mint without a session`, async () => {
        await expect(call(desktopRoutes.handoff, { idToken: `x` }, { context: context({ user: null }) })).rejects.toBeInstanceOf(ORPCError);
    });

    it(`returns both credentials and deletes the row in the same call`, async () => {
        const remove = vi.fn().mockResolvedValue({});
        const ctx = context({
            prisma: fakePrisma({
                desktopHandoff: { findUnique: vi.fn().mockResolvedValue(row(new Date(Date.now() + 60_000))), delete: remove },
            }),
            user: null, // sessionless on purpose — the webview has no session yet; that is what this route is for
        });

        await expect(call(desktopRoutes.redeem, { handoff: `h1` }, { context: ctx })).resolves.toEqual({
            ott: `ott-1`,
            idToken: `google-jwt`,
        });
        expect(remove).toHaveBeenCalledWith({ where: { id: `h1` } });
    });

    it(`gives an expired row the same answer as an unknown one, and still spends it`, async () => {
        const remove = vi.fn().mockResolvedValue({});
        const expired = context({
            prisma: fakePrisma({
                desktopHandoff: { findUnique: vi.fn().mockResolvedValue(row(new Date(Date.now() - 1))), delete: remove },
            }),
        });
        const unknown = context({
            prisma: fakePrisma({ desktopHandoff: { findUnique: vi.fn().mockResolvedValue(null), delete: vi.fn() } }),
        });

        await expect(call(desktopRoutes.redeem, { handoff: `h1` }, { context: expired })).rejects.toBeInstanceOf(ORPCError);
        await expect(call(desktopRoutes.redeem, { handoff: `h1` }, { context: unknown })).rejects.toBeInstanceOf(ORPCError);
        expect(remove).toHaveBeenCalledWith({ where: { id: `h1` } });
    });
});
