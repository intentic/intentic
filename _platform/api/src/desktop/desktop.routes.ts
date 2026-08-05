import { apiContract } from "@intentic-app/api-contract";
import { implement, ORPCError } from "@orpc/server";
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
                expiresAt: new Date(Date.now() + HANDOFF_TTL_MS),
            },
        });
        return { handoff: row.id };
    }),

    /* SESSIONLESS, and that is the whole point: the caller is the webview, which has no session yet. The id is
     * a cuid the app received over a link it asked for, and the row is deleted here — so a replayed link, a
     * second window, or a link recovered from a log finds nothing. Expired and unknown are the same answer
     * (no oracle), and the delete runs before either credential is returned so a crash mid-response cannot
     * leave a second pickup behind. */
    redeem: os.desktop.redeem.handler(async ({ input, context }) => {
        const row = await context.prisma.desktopHandoff.findUnique({ where: { id: input.handoff } });
        if (row !== null) {
            await context.prisma.desktopHandoff.delete({ where: { id: row.id } });
        }
        if (row === null || row.expiresAt < new Date()) {
            throw new ORPCError(`NOT_FOUND`, { message: `this sign-in link has already been used or expired` });
        }
        return { ott: decryptSecret(context.config, row.ott), idToken: decryptSecret(context.config, row.idToken) };
    }),
};
