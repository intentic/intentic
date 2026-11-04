import { ACCOUNT_CHANGED, ACCOUNT_HEADER, ACCOUNT_ID_PATTERN } from "@intentic/api-contract";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { parseCookies, parseSetCookieHeader } from "better-auth/cookies";
import { z } from "zod";

// What an after-hook finds an endpoint returned, as Better Auth types it.
type SessionAnswer = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0]["context"]["returned"];

// SEVERAL ACCOUNTS IN ONE BROWSER, the platform's half. Better Auth's multi-session plugin (auth.ts) keeps one signed
// `<session cookie>_multi-<token>` cookie per account beside the active session cookie, and lists, switches and revokes
// by them. Two things it leaves to us:
//
// 1. A session made before the plugin was switched on has no such cookie, so it is listed nowhere, and the first
//    "Add another account" overwrites the active cookie with the new account's: the one already signed in is lost from
//    this browser. Every session check adopts the active session into the list when its cookie is missing.
// 2. The cookie belongs to the browser, not to a page. A tab still drawn as one account can send its next call on the
//    cookie another tab switched to someone else, and rename, sign out or delete the wrong person. A page names the
//    account it is drawn for on every call that changes something (ACCOUNT_HEADER), and a call meant for someone other
//    than the session's account is refused before anything runs, here for Better Auth's own routes and in app.ts for
//    /rpc.

// The routes a page reaches before it knows who it is, or to find out, or to change who it is: a sign-in has no
// account yet, a session check is how a page learns it was switched, and set-active is the switch itself. Everything
// else under /api/auth acts on the signed-in account, so it is held to the header when one is sent.
const UNFENCED_PREFIXES = [`/sign-in/`, `/callback/`, `/oauth2/callback`, `/email-otp/`, `/one-time-token/`] as const;
const UNFENCED_PATHS = new Set([`/get-session`, `/one-tap/callback`, `/multi-session/list-device-sessions`, `/multi-session/set-active`, `/error`, `/ok`]);

export const fencedAuthPath = (path: string): boolean => !UNFENCED_PATHS.has(path) && !UNFENCED_PREFIXES.some((prefix) => path.startsWith(prefix));

// What a call meant for `expected` is told when the platform would answer it as `actual` instead: nothing when they are
// the same account; a malformed header is refused as one (a page never sends one, so it is not mistaken for a switch).
export type ExpectationRefusal = { readonly status: 400; readonly message: string } | { readonly status: 409; readonly message: string };

export const expectationRefusal = (expected: string, actual: string | undefined): ExpectationRefusal | undefined => {
    if (!ACCOUNT_ID_PATTERN.test(expected)) {
        return { status: 400, message: `The ${ACCOUNT_HEADER} header does not name an account.` };
    }
    if (actual === expected) {
        return undefined;
    }
    return {
        status: 409,
        message:
            actual === undefined
                ? `This browser is no longer signed in to the account this page was opened as.`
                : `This browser switched to another account since this page was opened. Reload to continue as that account.`,
    };
};

// The /rpc refusal, in the error shape the oRPC client turns into an ORPCError whose code is ACCOUNT_CHANGED, so the
// page reads it like any other refusal. Like every /rpc answer it goes out saying who the session is now (rpcAnswer).
export const rpcExpectationRefusal = (headers: Headers, answeredAs: string | undefined): Response | undefined => {
    const expected = headers.get(ACCOUNT_HEADER);
    if (expected === null) {
        return undefined;
    }
    const refusal = expectationRefusal(expected, answeredAs);
    if (refusal === undefined) {
        return undefined;
    }
    const code = refusal.status === 409 ? ACCOUNT_CHANGED : `BAD_REQUEST`;
    return Response.json({ defined: false, code, status: refusal.status, message: refusal.message }, { status: refusal.status });
};

// A /rpc answer as the browser receives it: with the cookies the session check rolled (Better Auth's refreshed cookie,
// an adopted device session), and saying whose answer it is, so a page drawn as another account drops it rather than
// showing it.
export const rpcAnswer = (response: Response, cookies: readonly string[], answeredAs: string | undefined): Response => {
    if (cookies.length === 0 && answeredAs === undefined) {
        return response;
    }
    const headers = new Headers(response.headers);
    for (const cookie of cookies) {
        headers.append(`set-cookie`, cookie);
    }
    if (answeredAs !== undefined) {
        headers.set(ACCOUNT_HEADER, answeredAs);
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};

// The one field of get-session's answer this reads: the session's token. Anything else (no session, an error) is no
// session to adopt.
const SessionAnswerSchema = z.object({ session: z.object({ token: z.string().min(1) }) });
const answeredToken = (returned: SessionAnswer): string | undefined => SessionAnswerSchema.safeParse(returned).data?.session.token;

const isMultiSessionCookie = (name: string): boolean => name.includes(`_multi-`);

export const deviceSessions = (options: { readonly maximumSessions: number }) =>
    ({
        id: `intentic-device-sessions`,
        hooks: {
            before: [
                {
                    // Only a call that names an account pays for a session read here; every other call is as it was.
                    matcher: (context) => context.headers?.get(ACCOUNT_HEADER) != null && fencedAuthPath(context.path ?? ``),
                    handler: createAuthMiddleware(async (ctx) => {
                        const expected = ctx.headers?.get(ACCOUNT_HEADER) ?? ``;
                        // No refresh: a refusal must leave the session exactly as it found it.
                        const session = await getSessionFromCtx(ctx, { disableRefresh: true });
                        const refusal = expectationRefusal(expected, session?.user.id);
                        if (refusal === undefined) {
                            return;
                        }
                        throw refusal.status === 409
                            ? new APIError(`CONFLICT`, { message: refusal.message, code: ACCOUNT_CHANGED })
                            : new APIError(`BAD_REQUEST`, { message: refusal.message });
                    }),
                },
            ],
            after: [
                {
                    matcher: (context) => context.path === `/get-session`,
                    handler: createAuthMiddleware(async (ctx) => {
                        const token = answeredToken(ctx.context.returned);
                        if (token === undefined) {
                            return;
                        }
                        const sessionCookie = ctx.context.authCookies.sessionToken;
                        const name = `${sessionCookie.name}_multi-${token.toLowerCase()}`;
                        const held = parseCookies(ctx.headers?.get(`cookie`) ?? ``);
                        // Already listed, or listed by this very answer (multi-session's own hook on a session it rolled).
                        if (held.has(name) || parseSetCookieHeader(ctx.context.responseHeaders?.get(`set-cookie`) ?? ``).has(name)) {
                            return;
                        }
                        // A browser already at the limit lists no more, as multi-session itself declines a sign-in past it.
                        if ([...held.keys()].filter(isMultiSessionCookie).length >= options.maximumSessions) {
                            return;
                        }
                        await ctx.setSignedCookie(name, token, ctx.context.secret, sessionCookie.attributes);
                    }),
                },
            ],
        },
    }) satisfies BetterAuthPlugin;
