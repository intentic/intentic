import { z } from "zod";

// Cloudflare Turnstile's server-side half, with the chat's own secret (`webchat.turnstileSecret`, which each site's owner
// set on its chat and the widget never sees). Why here rather than the door's `turnstile` protection, which the daemon
// verifies under one sandbox secret per route: a chat's keys are its site's own, so two chats on two sites carry two
// secrets, stored on their automations since before the move; and a chat asks for the check once per thread, not on
// every message, which a route's protection cannot tell apart.

const VERIFY_URL = `https://challenges.cloudflare.com/turnstile/v0/siteverify`;

// Cloudflare's answer, as far as it decides anything: anything but `success: true` is a failed check.
const VerdictSchema = z.object({ success: z.boolean() }).loose();

export type TurnstileVerify = (secret: string, token: string, remoteIp: string | undefined) => Promise<boolean>;

/** Whether Cloudflare says `token` passed for the site whose secret is `secret`; false when Cloudflare does not answer. */
export const verifyTurnstile: TurnstileVerify = async (secret, token, remoteIp) => {
    const body = new URLSearchParams({ secret, response: token });
    if (remoteIp !== undefined) {
        body.set(`remoteip`, remoteIp);
    }
    const response = await fetch(VERIFY_URL, { method: `POST`, body, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) {
        return false;
    }
    return VerdictSchema.safeParse(await response.json()).data?.success === true;
};
