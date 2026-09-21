import { API_BASE_PATH } from "@intentic/api-contract";
import { ORPCError } from "@orpc/server";
import { type Context, Hono } from "hono";
import type { Logger } from "pino";
import type { Auth } from "../auth.js";
import type { Config } from "../config.js";
import { buildOrpcContext } from "../context.js";
import { requireAdmin } from "../guards.js";
import type { PrismaClient } from "@intentic/prisma";

/* THE UPSTREAM READ LANE — a developer's local admin panel, showing another deployment's figures, with no credential in the browser. */

// Why this exists at all: a browser on https://localhost cannot read a production API directly. Its session cookie is
// SameSite=Lax, so the browser never attaches it cross-site, and production's CORS trusts exactly one origin. Neither
// is fixable from the panel, and both are load-bearing. A server-to-server hop has neither constraint, so the local
// API replays a stored cookie and the browser keeps talking only to its own origin.

// How long a forwarded read may take before the panel is told the upstream is unreachable.
const UPSTREAM_TIMEOUT_MS = 15_000;

type UpstreamVariables = { logger: Logger; admin: string };

export interface AdminUpstreamDeps {
    readonly config: Config;
    readonly prisma: PrismaClient;
    readonly auth: Auth;
    // Injectable so tests drive the lane without a second deployment to read.
    readonly fetchUpstream?: typeof fetch;
}

export const adminUpstreamRoutes = ({ config, prisma, auth, fetchUpstream = fetch }: AdminUpstreamDeps) => {
    const app = new Hono<{ Variables: UpstreamVariables }>();

    app.use(`/*`, async (c, next) => {
        // Both halves or nothing: a URL with no cookie would reach the upstream as an anonymous caller and read a
        // refusal, which is a worse answer than saying the lane is off.
        if (config.admin.upstreamUrl === `` || config.admin.upstreamCookie === ``) {
            return c.json({ message: `no upstream platform is configured (ADMIN_UPSTREAM_URL and ADMIN_UPSTREAM_COOKIE)` }, 404);
        }
        // READS ONLY, enforced by method rather than by a path list: every read in adminContract is a GET and every
        // mutation is a POST, so no write can cross this lane whatever the panel's bytes ask for.
        if (c.req.method !== `GET`) {
            return c.json({ message: `the upstream lane forwards reads only, and ${c.req.method} is not one` }, 405);
        }
        // Gated on THIS deployment's own ADMIN_EMAILS as well: reachable over loopback is not the same as authorized,
        // and the stored cookie must not be spendable by anything else that can open a port on the dev machine.
        const context = await buildOrpcContext({ auth, prisma, config, logger: c.get(`logger`) }, c.req.raw.headers);
        try {
            c.set(`admin`, requireAdmin(context).email);
        } catch (error) {
            if (error instanceof ORPCError) {
                // requireAdmin raises only these two: no session, or a session not on the allowlist.
                return c.json({ message: error.message === `` ? error.code : error.message }, error.code === `FORBIDDEN` ? 403 : 401);
            }
            throw error;
        }
        await next();
        return undefined;
    });

    const forward = async (c: Context<{ Variables: UpstreamVariables }>, route: string) => {
        const target = `${config.admin.upstreamUrl.replace(/\/+$/, ``)}${API_BASE_PATH}${route}${new URL(c.req.url).search}`;
        c.get(`logger`).info({ admin: c.get(`admin`), route, upstream: config.admin.upstreamUrl }, `admin upstream read`);
        let response: Response;
        try {
            response = await fetchUpstream(target, {
                // The stored cookie and nothing of the caller's own, so the upstream can only ever be reached as the
                // one account that cookie belongs to.
                headers: { accept: `application/json`, cookie: config.admin.upstreamCookie },
                signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
            });
        } catch (error) {
            c.get(`logger`).warn({ err: error, upstream: config.admin.upstreamUrl }, `admin upstream unreachable`);
            return c.json({ message: `the upstream platform did not answer` }, 502);
        }
        // A fresh response carrying only the body: the upstream's own Set-Cookie must never reach this browser, or the
        // dev tab silently becomes a session on the other deployment.
        return new Response(await response.text(), {
            status: response.status,
            headers: { "content-type": response.headers.get(`content-type`) ?? `application/json` },
        });
    };

    // Who the stored cookie belongs to, so the panel can name the upstream account it is reading as.
    app.get(`/me`, (c) => forward(c, `/me`));
    app.get(`/admin/:route{.+}`, (c) => forward(c, `/admin/${c.req.param(`route`)}`));
    // `message`, not `error`: the admin panel is the only caller and renders the platform's own sentence off that field.
    app.all(`/*`, (c) => c.json({ message: `the upstream lane mirrors /me and /admin reads only` }, 404));

    return app;
};
