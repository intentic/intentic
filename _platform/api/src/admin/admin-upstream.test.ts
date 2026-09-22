import { Hono } from "hono";
import type { Logger } from "pino";
import { describe, it, expect } from "bun:test";
import type { Auth } from "../auth.js";
import type { Config } from "../config.js";
import { adminUpstreamRoutes } from "./admin-upstream.routes.js";
import type { PrismaClient } from "@intentic/prisma";

// The lane's whole security story: off unless both halves are configured, gated on this deployment's own allowlist,
// reads only, and nothing of the upstream's session ever reaching the browser that asked.

const ADMIN = `radarsu@gmail.com`;
const COOKIE = `better-auth.session_token=tok.sig`;

const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as unknown as Logger;

const configWith = (overrides: Record<string, unknown>): Config =>
    ({
        admin: { emails: ADMIN, mutations: false, upstreamUrl: `https://api.intentic.dev`, upstreamCookie: COOKIE, ...overrides },
    }) as unknown as Config;

// Better Auth's one call buildOrpcContext makes, answered with whoever the case is signed in as.
const authAs = (email: string | null): Auth =>
    ({
        api: {
            getSession: async () => ({
                response: email === null ? null : { user: { id: `u1`, email, name: `x`, image: null } },
                headers: new Headers(),
            }),
        },
    }) as unknown as Auth;

interface Call {
    readonly url: string;
    readonly headers: Record<string, string>;
}

const serve = (options: {
    as?: string | null;
    config?: Record<string, unknown>;
    upstream?: (call: Call) => Response | Promise<Response>;
    calls?: Call[];
}) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    app.use(`*`, async (c, next) => {
        c.set(`logger`, logger);
        await next();
    });
    app.route(
        `/upstream`,
        adminUpstreamRoutes({
            config: configWith(options.config ?? {}),
            prisma: {} as unknown as PrismaClient,
            auth: authAs(options.as === undefined ? ADMIN : options.as),
            fetchUpstream: (async (url: string, init?: RequestInit) => {
                const call = { url: String(url), headers: (init?.headers ?? {}) as Record<string, string> };
                options.calls?.push(call);
                return options.upstream === undefined
                    ? new Response(`{"ok":true}`, { headers: { "content-type": `application/json` } })
                    : options.upstream(call);
            }) as unknown as typeof fetch,
        }),
    );
    return app;
};

describe(`the admin upstream read lane`, () => {
    it(`is off until both halves are set, and says which two they are`, async () => {
        const calls: Call[] = [];
        for (const off of [{ upstreamUrl: `` }, { upstreamCookie: `` }, { upstreamUrl: ``, upstreamCookie: `` }]) {
            const response = await serve({ config: off, calls }).request(`https://localhost:6480/upstream/admin/overview`);
            expect(response.status).toBe(404);
            expect((await response.json()).message).toContain(`ADMIN_UPSTREAM_URL`);
        }
        // A configured URL with no cookie must not be tried anonymously: that reads a refusal, not the figures.
        expect(calls).toEqual([]);
    });

    it(`refuses a caller with no session, and one this deployment's allowlist does not name`, async () => {
        const calls: Call[] = [];
        expect((await serve({ as: null, calls }).request(`https://localhost:6480/upstream/admin/overview`)).status).toBe(401);
        expect((await serve({ as: `visitor@example.com`, calls }).request(`https://localhost:6480/upstream/admin/overview`)).status).toBe(403);
        expect(calls).toEqual([]);
    });

    it(`forwards a read with the stored cookie and the query string, and nothing of the caller's own`, async () => {
        const calls: Call[] = [];
        const response = await serve({ calls }).request(`https://localhost:6480/upstream/admin/users?limit=2&query=radar`, {
            headers: { cookie: `better-auth.session_token=the-callers-own`, authorization: `Bearer nope` },
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ ok: true });
        expect(calls).toHaveLength(1);
        expect(calls[0]?.url).toBe(`https://api.intentic.dev/rpc/admin/users?limit=2&query=radar`);
        // Exactly the stored cookie: the caller's own session is not appended, forwarded, or merged.
        expect(calls[0]?.headers).toEqual({ accept: `application/json`, cookie: COOKIE });
    });

    it(`carries the upstream's own status and body back, so a refusal reads as the upstream's sentence`, async () => {
        const app = serve({
            upstream: () => new Response(`{"message":"not on ADMIN_EMAILS"}`, { status: 403, headers: { "content-type": `application/json` } }),
        });
        const response = await app.request(`https://localhost:6480/upstream/admin/overview`);
        expect(response.status).toBe(403);
        expect((await response.json()).message).toBe(`not on ADMIN_EMAILS`);
    });

    it(`never hands the upstream's Set-Cookie to the browser that asked`, async () => {
        const app = serve({
            upstream: () =>
                new Response(`{}`, { headers: { "content-type": `application/json`, "set-cookie": `better-auth.session_token=upstream; Path=/` } }),
        });
        const response = await app.request(`https://localhost:6480/upstream/admin/overview`);
        expect(response.headers.getSetCookie()).toEqual([]);
    });

    it(`forwards /me, so the panel can name the account the stored cookie belongs to`, async () => {
        const calls: Call[] = [];
        expect((await serve({ calls }).request(`https://localhost:6480/upstream/me`)).status).toBe(200);
        expect(calls[0]?.url).toBe(`https://api.intentic.dev/rpc/me`);
    });

    it(`refuses every write, and reaches the upstream for none of them`, async () => {
        const calls: Call[] = [];
        const app = serve({ calls });
        for (const path of [`/upstream/admin/user/delete`, `/upstream/admin/machine/stop`, `/upstream/admin/user/suspend`]) {
            const response = await app.request(`https://localhost:6480${path}`, {
                method: `POST`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ userId: `u2`, confirmEmail: `someone@example.com` }),
            });
            expect(response.status).toBe(405);
        }
        expect(calls).toEqual([]);
    });

    it(`answers 502 when the upstream does not answer, rather than hanging the panel`, async () => {
        const app = serve({
            upstream: () => {
                throw new Error(`ECONNREFUSED`);
            },
        });
        const response = await app.request(`https://localhost:6480/upstream/admin/overview`);
        expect(response.status).toBe(502);
        expect((await response.json()).message).toContain(`did not answer`);
    });

    it(`mirrors /me and /admin only`, async () => {
        const calls: Call[] = [];
        const response = await serve({ calls }).request(`https://localhost:6480/upstream/sandbox/list`);
        expect(response.status).toBe(404);
        expect(calls).toEqual([]);
    });

    it(`trims a trailing slash off the configured upstream rather than doubling it`, async () => {
        const calls: Call[] = [];
        await serve({ config: { upstreamUrl: `https://api.intentic.dev/` }, calls }).request(`https://localhost:6480/upstream/admin/overview`);
        expect(calls[0]?.url).toBe(`https://api.intentic.dev/rpc/admin/overview`);
    });
});
