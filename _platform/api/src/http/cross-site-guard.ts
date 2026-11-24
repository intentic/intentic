import { PLATFORM_INGRESS } from "@intentic/api-contract";
import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";

/* THE CROSS-SITE REQUEST GUARD. The session cookie is SameSite=Lax, which keeps it off a request another SITE starts, but
 * every sandbox is a page under the ingress zone (*.sbx.intentic.dev), the same site as this API: a page a sandbox serves
 * could post a form or a no-cors fetch to /rpc and the browser would attach the reader's cookie. So a state-changing
 * request that carries a cookie is served only when the browser says it came from the editor or from this API's own
 * origin: its Origin names one of them, or, with no Origin, Sec-Fetch-Site says same-origin. A request with neither
 * header is not a browser's (the desktop app and the mobile core send the cookie themselves) and passes, as does every
 * request with no cookie, since nothing ambient vouches for it. (2026-11-24) A CSRF token was passed over: every client
 * that sends the cookie by hand would have had to learn to fetch and echo one, and no browser lets a page forge Origin. */

// What a request may do without the guard looking: a browser sends these without asking, and none of them changes state.
const SAFE_METHODS = new Set([`GET`, `HEAD`, `OPTIONS`]);

// Better Auth's own routes: its origin check refuses a cookie-bearing write whose Origin (or Referer) is not one of its
// trustedOrigins, which are the same two origins (auth.ts), so a second check here would only say it again.
const AUTH_PREFIX = `/api/auth/`;

// Stripe's webhook: signed by Stripe (hosted-plan.routes.ts), never read under a session.
const STRIPE_WEBHOOK = `/hosted-plan/webhook`;

// The machine routes (api-contract PLATFORM_INGRESS): each is authorized by what the request itself carries (a connect
// token, a setup or fix code, a report key, the platform token, an API token), never by a cookie a browser attached.
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, `\\$&`);
const routePattern = (path: string): RegExp => {
    const literal = path.split(/\{[^}]+\}/u).map(escaped);
    return new RegExp(`^${literal.join(`[^/]+`)}$`, `u`);
};
const MACHINE_ROUTES = Object.values(PLATFORM_INGRESS).map((route) => ({ method: route.method, pattern: routePattern(route.path) }));

export const exemptFromGuard = (method: string, path: string): boolean =>
    path.startsWith(AUTH_PREFIX) || path === STRIPE_WEBHOOK || MACHINE_ROUTES.some((route) => route.method === method && route.pattern.test(path));

// The origins a cookie-bearing write may come from: the editor this platform serves and the API's own.
const allowedOriginsOf = (config: Pick<Config, "webOrigin" | "api">): ReadonlySet<string> =>
    new Set([new URL(config.webOrigin).origin, new URL(config.api.url).origin]);

// Whether the browser says the request came from an allowed origin. Origin is authoritative when sent (`null`, a
// sandboxed frame's or a data: page's, names none and so no allowed one); without it, Sec-Fetch-Site decides, where
// `same-site` is exactly a sandbox's page and `none` is the person's own navigation, which no page can start. Neither
// header is a client that is not a browser.
export const fromAllowedOrigin = (allowed: ReadonlySet<string>, origin: string | undefined, fetchSite: string | undefined): boolean => {
    if (origin !== undefined && origin !== ``) {
        return allowed.has(origin);
    }
    if (fetchSite !== undefined && fetchSite !== ``) {
        return fetchSite === `same-origin` || fetchSite === `none`;
    }
    return true;
};

export const crossSiteGuard = <E extends { Variables: { logger: Logger } }>(config: Pick<Config, "webOrigin" | "api">): MiddlewareHandler<E> => {
    const allowed = allowedOriginsOf(config);
    return async (c, next) => {
        const method = c.req.method;
        if (SAFE_METHODS.has(method) || c.req.header(`cookie`) === undefined || exemptFromGuard(method, c.req.path)) {
            return next();
        }
        const origin = c.req.header(`origin`);
        const fetchSite = c.req.header(`sec-fetch-site`);
        if (fromAllowedOrigin(allowed, origin, fetchSite)) {
            return next();
        }
        c.get(`logger`).warn(
            { method, path: c.req.path, origin, fetchSite },
            `cross-site request refused: a cookie-bearing write from an origin this platform does not serve`,
        );
        // In oRPC's error shape, so the editor's client reads it as any other refusal.
        return c.json({ defined: false, code: `FORBIDDEN`, status: 403, message: `cross-site request refused` }, 403);
    };
};
