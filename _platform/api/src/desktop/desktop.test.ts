import { call, ORPCError } from "@orpc/server";
import { createHash } from "node:crypto";
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

const verifier = `v`.repeat(64);
const challenge = createHash(`sha256`).update(verifier).digest(`base64url`);
const row = (expiresAt: Date) => ({ id: `h1`, ott: `ott-1`, idToken: `google-jwt`, challenge, expiresAt, createdAt: new Date() });

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

        await expect(call(desktopRoutes.handoff, { idToken: `google-jwt`, challenge }, { context: ctx })).resolves.toEqual({ handoff: `h1` });
        // The caller's OWN headers, not a fresh request: the token has to belong to the session that asked.
        expect(generateOneTimeToken).toHaveBeenCalledWith({ headers });
        expect(create.mock.calls[0]?.[0]?.data).toMatchObject({ ott: `ott-1`, idToken: `google-jwt`, challenge });
    });

    it(`refuses to mint without a session`, async () => {
        await expect(call(desktopRoutes.handoff, { idToken: `x`, challenge }, { context: context({ user: null }) })).rejects.toBeInstanceOf(
            ORPCError,
        );
    });

    it(`returns both credentials and deletes the row in the same call`, async () => {
        const remove = vi.fn().mockResolvedValue({ count: 1 });
        const ctx = context({
            prisma: fakePrisma({
                desktopHandoff: { findUnique: vi.fn().mockResolvedValue(row(new Date(Date.now() + 60_000))), deleteMany: remove },
            }),
            user: null, // sessionless on purpose — the webview has no session yet; that is what this route is for
        });

        await expect(call(desktopRoutes.redeem, { handoff: `h1`, verifier }, { context: ctx })).resolves.toEqual({
            ott: `ott-1`,
            idToken: `google-jwt`,
        });
        expect(remove).toHaveBeenCalledWith({ where: { id: `h1`, challenge } });
    });

    it(`gives an expired row the same answer as an unknown one without exposing credentials`, async () => {
        const remove = vi.fn().mockResolvedValue({ count: 1 });
        const expired = context({
            prisma: fakePrisma({
                desktopHandoff: { findUnique: vi.fn().mockResolvedValue(row(new Date(Date.now() - 1))), deleteMany: remove },
            }),
        });
        const unknown = context({
            prisma: fakePrisma({ desktopHandoff: { findUnique: vi.fn().mockResolvedValue(null), deleteMany: vi.fn() } }),
        });

        await expect(call(desktopRoutes.redeem, { handoff: `h1`, verifier }, { context: expired })).rejects.toBeInstanceOf(ORPCError);
        await expect(call(desktopRoutes.redeem, { handoff: `h1`, verifier }, { context: unknown })).rejects.toBeInstanceOf(ORPCError);
        expect(remove).not.toHaveBeenCalled();
    });

    /* The credential the platform already holds, which is what lets the hand-off page finish without putting a
     * Google button in front of someone who has just signed in twice. Session-scoped, and never an error when
     * there is nothing to give: the caller's fallback IS the Google button, and a 500 would replace a page
     * that still works with one that does not. */
    it(`hands back the Google token already on file for this session`, async () => {
        const getAccessToken = vi.fn().mockResolvedValue({ accessToken: `at`, idToken: `google-jwt`, scopes: [] });
        const headers = new Headers({ cookie: `session=abc` });
        const ctx = context({ auth: { api: { getAccessToken } } as unknown as OrpcContext[`auth`], headers });

        await expect(call(desktopRoutes.googleIdToken, {}, { context: ctx })).resolves.toEqual({ idToken: `google-jwt` });
        expect(getAccessToken).toHaveBeenCalledWith({ body: { providerId: `google` }, headers });
    });

    it(`says it holds nothing rather than failing when Google returns no id token`, async () => {
        const ctx = context({
            auth: { api: { getAccessToken: vi.fn().mockResolvedValue({ accessToken: `at`, scopes: [] }) } } as unknown as OrpcContext[`auth`],
        });

        await expect(call(desktopRoutes.googleIdToken, {}, { context: ctx })).resolves.toEqual({ idToken: undefined });
    });

    // A sign-in that left no refresh token, or an account since unlinked. Both are "we hold nothing", and the
    // page answers them the same way it always did: by showing Google's button.
    it(`says it holds nothing rather than failing when the refresh is refused`, async () => {
        const ctx = context({
            auth: {
                api: { getAccessToken: vi.fn().mockRejectedValue(new Error(`no refresh token`)) },
            } as unknown as OrpcContext[`auth`],
        });

        await expect(call(desktopRoutes.googleIdToken, {}, { context: ctx })).resolves.toEqual({});
    });

    it(`refuses to hand back a Google token without a session`, async () => {
        await expect(call(desktopRoutes.googleIdToken, {}, { context: context({ user: null }) })).rejects.toBeInstanceOf(ORPCError);
    });

    it(`a wrong verifier neither returns credentials nor consumes the app's attempt`, async () => {
        const remove = vi.fn().mockResolvedValue({ count: 1 });
        const ctx = context({
            prisma: fakePrisma({
                desktopHandoff: { findUnique: vi.fn().mockResolvedValue(row(new Date(Date.now() + 60_000))), deleteMany: remove },
            }),
            user: null,
        });
        await expect(call(desktopRoutes.redeem, { handoff: `h1`, verifier: `wrong-${verifier}` }, { context: ctx })).rejects.toBeInstanceOf(
            ORPCError,
        );
        expect(remove).not.toHaveBeenCalled();
    });
});
