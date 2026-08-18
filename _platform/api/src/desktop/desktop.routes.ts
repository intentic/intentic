import { apiContract } from "@intentic-app/api-contract";
import { implement, ORPCError } from "@orpc/server";
import { createHash, timingSafeEqual } from "node:crypto";
import type { OrpcContext } from "../context.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { requireUser } from "../guards.js";

const os = implement(apiContract).$context<OrpcContext>();

/* THE DESKTOP SIGN-IN HANDOFF — one sign-in, carried from the user's real browser into the app's webview.
 *
 * Google refuses OAuth authorization from an embedded webview, and Google Identity Services is FedCM-based,
 * which WebKitGTK does not implement at all. So the desktop app never asks Google for anything: it opens
 * /desktop-auth in the DEFAULT browser, where sign-in is the flow that already works, and picks the result up
 * over the `intentic://` link it already intercepts.
 *
 * Two credentials cross, and they cross differently on purpose:
 *   • the PLATFORM session, as a Better Auth one-time token. The webview spends it at
 *     /api/auth/one-time-token/verify, which answers with a Set-Cookie — so the session lands in the webview's
 *     own jar through an ordinary HTTP round trip, and nothing here forges a cookie or hand-rolls a session.
 *   • the GOOGLE ID token, which the daemon verifies against Google's JWKS on first-bind and then exchanges
 *     once for a daemon session that renews silently. The platform stores it for minutes and never uses it.
 *
 * Neither rides the deep link. A deep link is delivered as a process argument, which every other process on
 * the machine can read; the link carries only this row's id, and the row is deleted by the first redeem. */

// Long enough for a browser redirect the app reacts to immediately, short enough that a link left in a
// history file is inert by the time anyone reads it. Better Auth's own one-time token expires in three
// minutes, so a longer window here would only be a row outliving what it holds.
const HANDOFF_TTL_MS = 3 * 60_000;

const challengeOf = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");
const challengesMatch = (left: string, right: string): boolean => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
};

export const desktopRoutes = {
    // Session required — this is the browser that just signed in, and the token it mints is FOR that session.
    handoff: os.desktop.handoff.handler(async ({ input, context }) => {
        requireUser(context);
        const minted = await context.auth.api.generateOneTimeToken({ headers: context.headers });
        if (minted === null || minted === undefined) {
            throw new ORPCError(`UNAUTHORIZED`);
        }
        const row = await context.prisma.desktopHandoff.create({
            data: {
                ott: encryptSecret(context.config, minted.token),
                idToken: encryptSecret(context.config, input.idToken),
                challenge: input.challenge,
                expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
            },
        });
        return { handoff: row.id };
    }),

    /* SESSIONLESS, and that is the whole point: the caller is the webview, which has no session yet. The id is
     * public in the deep link; the verifier is retained by the app and proves this is the process that started
     * it. Expired, unknown, raced, and wrong-verifier attempts share one answer (no oracle). */
    redeem: os.desktop.redeem.handler(async ({ input, context }) => {
        const row = await context.prisma.desktopHandoff.findUnique({ where: { id: input.handoff } });
        if (row === null || row.expiresAt < new Date() || !challengesMatch(row.challenge, challengeOf(input.verifier))) {
            throw new ORPCError(`NOT_FOUND`, { message: `this sign-in link has already been used or expired` });
        }
        // The conditional delete is the single-use claim. Two correct redeemers may both read the row, but
        // only one sees count=1. A wrong verifier never consumes the real app's pending attempt.
        const spent = await context.prisma.desktopHandoff.deleteMany({ where: { id: row.id, challenge: row.challenge } });
        if (spent.count !== 1) {
            throw new ORPCError(`NOT_FOUND`, { message: `this sign-in link has already been used or expired` });
        }
        return { ott: decryptSecret(context.config, row.ott), idToken: decryptSecret(context.config, row.idToken) };
    }),

    /* The Google ID token already on file for this session's user, refreshed by Better Auth off the stored
     * refresh token when the one it holds has aged out. The hand-off page tries this BEFORE Google's own
     * button, so the ordinary desktop sign-in asks Google once — in the browser, where the user already
     * answered — rather than twice.
     *
     * Everything here is best-effort by design. Google does not always return an ID token on a refresh, a
     * sign-in that produced no refresh token has nothing to refresh, and an account can have been unlinked
     * since. All of those are "we hold nothing", not failures worth a 500: the caller's fallback is the
     * Google button it is already showing, and an error would only replace a working screen with a broken
     * one. The caller re-checks the expiry itself — this promises provenance, never freshness. */
    googleIdToken: os.desktop.googleIdToken.handler(async ({ context }) => {
        requireUser(context);
        try {
            const granted = await context.auth.api.getAccessToken({
                body: { providerId: `google` },
                headers: context.headers,
            });
            return { idToken: granted?.idToken };
        } catch {
            return {};
        }
    }),
};
