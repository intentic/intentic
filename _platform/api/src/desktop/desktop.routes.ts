import { apiContract } from "@intentic/api-contract";
import { implement, ORPCError } from "@orpc/server";
import { createHash, timingSafeEqual } from "node:crypto";
import type { OrpcContext } from "../context.js";
import { decryptSecret, encryptSecret } from "../crypto.js";
import { requireUser } from "../guards.js";

const os = implement(apiContract).$context<OrpcContext>();

// One sign-in, carried into the app's webview via the intentic:// deep link, since Google refuses OAuth in an embedded
// webview. The platform session (a one-time token) and the Google ID token cross separately; only the row id rides the
// link itself.

// Long enough for an immediate redirect, short enough that a link in history is inert by the time it's read.
const HANDOFF_TTL_MS = 3 * 60_000;

const challengeOf = (verifier: string): string => createHash("sha256").update(verifier).digest("base64url");
const challengesMatch = (left: string, right: string): boolean => {
    const a = Buffer.from(left);
    const b = Buffer.from(right);
    return a.length === b.length && timingSafeEqual(a, b);
};

export const desktopRoutes = {
    // Session required: this is the browser that just signed in, and the token minted is for that session.
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

    // Sessionless by design: the caller is the webview. Expired, unknown, raced, wrong-verifier share one answer.
    redeem: os.desktop.redeem.handler(async ({ input, context }) => {
        const row = await context.prisma.desktopHandoff.findUnique({ where: { id: input.handoff } });
        if (row === null || row.expiresAt < new Date() || !challengesMatch(row.challenge, challengeOf(input.verifier))) {
            throw new ORPCError(`NOT_FOUND`, { message: `this sign-in link has already been used or expired` });
        }
        // The conditional delete is the single-use claim; a wrong verifier never consumes the real pending attempt.
        const spent = await context.prisma.desktopHandoff.deleteMany({ where: { id: row.id, challenge: row.challenge } });
        if (spent.count !== 1) {
            throw new ORPCError(`NOT_FOUND`, { message: `this sign-in link has already been used or expired` });
        }
        return { ott: decryptSecret(context.config, row.ott), idToken: decryptSecret(context.config, row.idToken) };
    }),

    // Best-effort refresh of the on-file Google ID token, tried before Google's own button; never a 500.
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
