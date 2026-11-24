import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import { createApp } from "../app.js";
import { configSchema } from "../config.js";
import { exemptFromGuard, fromAllowedOrigin } from "./cross-site-guard.js";
import { testIngressConfig } from "../testing.js";

/* THE CROSS-SITE REQUEST GUARD on the app as it is mounted: a cookie-bearing write from a sandbox's page (the same site
 * as the API) is refused before any route runs, the editor, the API's own origin and a client that is not a browser are
 * served, and the machine routes, Stripe's webhook and Better Auth's own routes are left to their own checks. Mode: no
 * database; every request that passes the guard reaches a route that answers before it would read one. */

const WEB = `https://app.test`;
const API = `https://api.test`;
const SANDBOX_PAGE = `https://sandbox-0123456789ab.sbx.test`;

const config = configSchema.parse({
    database: { url: `postgres://x` },
    betterAuth: { secret: `s` },
    webOrigin: WEB,
    ingress: testIngressConfig,
    api: { url: API },
    log: { level: `silent`, pretty: `false` },
});

// SAFETY: the app and the guard log through these five methods and nothing else.
const logger: Logger = { child: () => logger, info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as never;
// SAFETY: no request here reaches the database; one that did would fail on the missing delegate rather than pass.
const prisma = {} as PrismaClient;
const app = createApp(config, prisma, logger).app;

// A write carries a body as a form or a no-cors fetch would, in a type no preflight guards; a read carries none.
const send = (path: string, headers: HeaderSet, method = `POST`) => {
    const init: RequestInit = { method, headers: { "content-type": `text/plain`, ...headers } };
    if (method !== `GET`) {
        init.body = `{}`;
    }
    return app.request(path, init);
};

const COOKIE = { cookie: `__Secure-better-auth.session_token=tok.sig` };
type HeaderSet = Readonly<Record<string, string>>;

describe(`a cookie-bearing write`, () => {
    it(`is refused from a sandbox's page, whether its Origin or only Sec-Fetch-Site says so`, async () => {
        const sandboxPages: HeaderSet[] = [
            { origin: SANDBOX_PAGE },
            { "sec-fetch-site": `same-site` },
            { "sec-fetch-site": `cross-site` },
            { origin: `null` },
        ];
        for (const headers of sandboxPages) {
            const refused = await send(`/rpc/sandbox/create`, { ...COOKIE, ...headers });
            expect(refused.status).toBe(403);
            expect(await refused.json()).toEqual({ defined: false, code: `FORBIDDEN`, status: 403, message: `cross-site request refused` });
        }
        // The Repair lane reads the same session, outside /rpc.
        expect((await send(`/api/repair/turn`, { ...COOKIE, origin: SANDBOX_PAGE })).status).toBe(403);
    });

    it(`is served from the editor, from the API's own origin, and from a client that is not a browser`, async () => {
        // Repair is off on this platform, so a request the guard lets through is answered 404 by the route itself.
        const trusted: HeaderSet[] = [{ origin: WEB }, { origin: API }, { "sec-fetch-site": `same-origin` }, {}];
        for (const headers of trusted) {
            const served = await send(`/api/repair/turn`, { ...COOKIE, ...headers });
            expect(served.status).toBe(404);
            expect(await served.json()).toEqual({ error: `repair is not enabled on this platform` });
        }
    });

    it(`is the only kind looked at: no cookie, or a read, passes from anywhere`, async () => {
        expect((await send(`/api/repair/turn`, { origin: SANDBOX_PAGE })).status).toBe(404);
        expect((await send(`/api/repair/turn`, { ...COOKIE, origin: SANDBOX_PAGE }, `GET`)).status).toBe(404);
    });
});

describe(`what the guard leaves to its own check`, () => {
    it(`passes a machine route and Stripe's webhook whatever the browser attached`, async () => {
        const hostile = { ...COOKIE, origin: SANDBOX_PAGE };
        expect(await (await send(`/setup/report`, hostile)).json()).toEqual({
            error: `malformed report: a setup report names its live code, its stage and what failed`,
        });
        // A route with a parameter in its path, matched as one segment.
        expect(await (await send(`/sandbox/hosted-build-report/b1`, hostile)).json()).toEqual({ error: `missing build secret` });
        expect(await (await send(`/hosted-plan/webhook`, hostile)).json()).toEqual({ error: `the hosted plan is not enabled on this platform` });
    });

    it(`names Better Auth's routes, the machine routes by method and path, and nothing under /rpc`, () => {
        expect(exemptFromGuard(`POST`, `/api/auth/sign-out`)).toBe(true);
        expect(exemptFromGuard(`POST`, `/sandbox/announce`)).toBe(true);
        expect(exemptFromGuard(`POST`, `/sandbox/hosted-build-report/b1`)).toBe(true);
        // A parameter is one segment, never a path that runs on past it.
        expect(exemptFromGuard(`POST`, `/sandbox/hosted-build-report/b1/more`)).toBe(false);
        expect(exemptFromGuard(`POST`, `/rpc/sandbox/create`)).toBe(false);
        expect(exemptFromGuard(`POST`, `/api/repair/turn`)).toBe(false);
    });
});

describe(`reading what the browser says`, () => {
    const allowed = new Set([WEB, API]);

    it(`takes Origin over Sec-Fetch-Site, and a client that sends neither for one that is not a browser`, () => {
        expect(fromAllowedOrigin(allowed, WEB, `cross-site`)).toBe(true);
        expect(fromAllowedOrigin(allowed, SANDBOX_PAGE, `same-origin`)).toBe(false);
        expect(fromAllowedOrigin(allowed, undefined, `none`)).toBe(true);
        expect(fromAllowedOrigin(allowed, ``, `same-site`)).toBe(false);
        expect(fromAllowedOrigin(allowed, undefined, undefined)).toBe(true);
    });
});
