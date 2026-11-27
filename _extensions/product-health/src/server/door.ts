import { timingSafeEqual } from "node:crypto";
import type { PublicRouteHandler } from "@intentic/extension-api";

/* THE DOOR POSTHOG'S ALERTS POST TO (`contributes.publicRoutes`, /door/<id>/hook/<token>): an error-tracking alert that
   fires (a new error, one that came back, one spiking) brings the next round forward, so the row and any automation's
   wake follow within a minute rather than ten. The body is never read: it came from the internet, and the round reads
   PostHog itself with the owner's key, so a forged post can at most bring a round forward, never put words anywhere.
   The token in the path keeps strangers from spending PostHog's budget even that way; the daemon's own rate and day
   limits hold either way. */

const sameToken = (given: string, token: string): boolean => {
    const left = Buffer.from(given);
    const right = Buffer.from(token);
    return left.length === right.length && timingSafeEqual(left, right);
};

export const doorOf =
    (hookToken: () => Promise<string>, nudge: () => void): PublicRouteHandler =>
    async (request) => {
        const [, head, given, extra] = new URL(request.url).pathname.split(`/`);
        if (head !== `hook` || given === undefined || extra !== undefined || request.method !== `POST`) {
            return undefined;
        }
        if (!sameToken(decodeURIComponent(given), await hookToken())) {
            return new Response(null, { status: 404 });
        }
        nudge();
        return new Response(null, { status: 202 });
    };
