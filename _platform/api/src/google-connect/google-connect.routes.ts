import { apiContract } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import { Hono } from "hono";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { requireUser } from "../guards.js";
import { ingressServer } from "../ingress.js";
import { consentUrl, exchangeCode, GoogleRefusal, googleConnectEnabled, type Http, refreshAccess } from "./google-connect.js";

const os = implement(apiContract).$context<OrpcContext>();

/* Connect Google's two doors. The browser's (oRPC, a signed-in session): build the consent URL, then trade the code the
 * popup brought back. A session is required on both so this platform is not an open code exchanger for its own client;
 * the PKCE verifier only the opening editor holds is what binds a code to the person who started the consent. The
 * sandbox's (ingress, its connect token): an access token for a refresh token the card holds. Neither stores anything. */

const NOT_HERE = `this platform has no Google client of its own: connect with your own OAuth client under Advanced`;

// What a refused code trade means to the person who just clicked through Google's consent.
const finishRefusal = (refusal: GoogleRefusal): string => {
    if (refusal.code === `invalid_grant`) {
        return `Google did not accept that sign-in (it expired or was already used): connect again`;
    }
    if (refusal.code === `no_refresh_token`) {
        return `Google answered without a lasting grant: connect again and approve the consent screen to the end`;
    }
    return `Google refused the sign-in (${refusal.code})`;
};

export const googleConnectRoutes = (http: Http = fetch) => ({
    begin: os.googleConnect.begin.handler(({ input, context }) => {
        requireUser(context);
        if (!googleConnectEnabled(context.config)) {
            throw new ORPCError(`NOT_FOUND`, { message: NOT_HERE });
        }
        return { url: consentUrl(context.config, input) };
    }),
    finish: os.googleConnect.finish.handler(async ({ input, context }) => {
        requireUser(context);
        if (!googleConnectEnabled(context.config)) {
            throw new ORPCError(`NOT_FOUND`, { message: NOT_HERE });
        }
        try {
            return await exchangeCode(context.config, http, input.code, input.codeVerifier);
        } catch (error) {
            if (error instanceof GoogleRefusal) {
                throw new ORPCError(`BAD_REQUEST`, { message: finishRefusal(error) });
            }
            throw error;
        }
    }),
});

export interface GoogleConnectDoor {
    readonly config: Config;
    // Whether a connect token names a sandbox this platform knows.
    readonly sandboxKnown: (connectToken: string) => Promise<boolean>;
    // Injectable so tests drive the trade without Google.
    readonly http?: Http;
}

export const googleConnectHttpRoutes = ({ config, prisma }: { readonly config: Config; readonly prisma: PrismaClient }) =>
    googleConnectDoor({
        config,
        sandboxKnown: async (token) => (await prisma.sandbox.findUnique({ where: { tokenDigest: sha256Hex(token) }, select: { id: true } })) !== null,
    });

export const googleConnectDoor = ({ config, sandboxKnown, http = fetch }: GoogleConnectDoor) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    const ingress = ingressServer(app, `/google-connect`);

    // Any sandbox this platform knows may ask: the refresh token is the grant, and it was issued to a person through
    // this client, so the connect token only keeps the door from being an open relay for whoever finds it.
    ingress(`googleAccessToken`, async (c, kit) => {
        if (!googleConnectEnabled(config)) {
            return kit.refuse(404, NOT_HERE);
        }
        const token = kit.connectToken;
        if (token === undefined) {
            return kit.refuse(400, `missing token`);
        }
        if (!(await sandboxKnown(token))) {
            return kit.refuse(404, `unknown sandbox`);
        }
        const body = await kit.body();
        if (body === undefined) {
            return kit.refuse(400, `the body must be {"refreshToken":"…"}`);
        }
        try {
            return kit.answer(await refreshAccess(config, http, body.refreshToken));
        } catch (error) {
            if (error instanceof GoogleRefusal) {
                // Google's own code as the whole refusal, which the sandbox's CLI turns into what the owner does about it.
                return kit.refuse(error.status >= 500 ? 502 : 400, error.code);
            }
            c.get(`logger`).warn({ err: error }, `google access token trade failed`);
            return kit.refuse(502, `Google could not be reached`);
        }
    });

    return app;
};
