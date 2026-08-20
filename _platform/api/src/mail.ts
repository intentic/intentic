import type { Config } from "./config.js";
import type { Logger } from "pino";

/* The platform's transactional mail, and every piece of it that is not the wording.
 *
 * Both mails it sends are the same object, one link, and the sentence that says why it arrived: an invite to
 * someone else's sandbox, and a way back to a setup that has to be finished on a different machine. So the
 * frame and the transport live here and the two callers own only their words.
 *
 * Talks to Resend's HTTP API directly (no SDK, a single authenticated POST, like cloudflare.ts). When email is
 * unconfigured the link is LOGGED instead of sent, so both flows still work on a dev machine with no mail
 * credentials; a non-2xx propagates, so the mutation that sent the mail fails and the caller can retry.
 *
 * A send therefore has THREE outcomes, not two, and the caller is told which, a mail that was never attempted
 * is not the same event as one that went out, and a flow whose whole point is delivering a link has to be able
 * to say so. `unconfigured` and `local-link` are the two ways this platform declines to send; the caller decides
 * what that means for the mutation (for an invite: keep the grant, hand the owner the link).
 */
export type MailDelivery = "sent" | "unconfigured" | "local-link";

export interface Mail {
    to: string;
    subject: string;
    /* The link the mail exists to deliver. Its own field rather than something to dig back out of `html`,
     * because it is exactly what the unconfigured-dev branch logs, a developer reads it out of the server
     * output and carries on with the flow by hand. */
    link: string;
    html: string;
}

// The shared frame: a heading, a sentence, the button, and the same link again as text. The last part is not
// decoration, a mail client that strips the anchor, or a reader forwarding this to the machine it is meant
// for, still needs the URL somewhere it can be selected.
export const linkEmail = (mail: { heading: string; body: string; action: string; link: string }): string => `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 30rem; margin: 0 auto; color: #1a1a1a;">
        <h2 style="font-size: 1.25rem; font-weight: 600;">${mail.heading}</h2>
        <p style="color: #555; line-height: 1.5;">${mail.body}</p>
        <p style="margin: 1.5rem 0;">
            <a href="${mail.link}" style="background: #4f46e5; color: #fff; padding: 0.6rem 1.1rem; border-radius: 0.5rem; text-decoration: none; font-weight: 600;">
                ${mail.action}
            </a>
        </p>
        <p style="color: #888; font-size: 0.8rem;">Or paste this link into your browser:<br />${mail.link}</p>
    </div>
`;

/* A link that only resolves on the machine that built it, the dev default (WEB_ORIGIN=https://localhost:…),
 * and anyone else running this platform locally. Mailing one is worse than not mailing it: the recipient gets a
 * real invitation whose button lands on their OWN empty localhost, so the failure surfaces at the far end, to
 * the person least able to explain it. Declining keeps it at the near end, where the link can still be copied
 * and handed over by hand. Only loopback counts, a platform on a LAN address is reachable by the people on
 * that LAN, which is exactly who its invites are for. */
const resolvesOnlyHere = (link: string): boolean => {
    try {
        const host = new URL(link).hostname.replace(/^\[|]$/g, ``);
        return host === `localhost` || host.endsWith(`.localhost`) || host === `127.0.0.1` || host === `::1`;
    } catch {
        // Not a URL at all: not this function's complaint to make. The send below fails or succeeds on its own.
        return false;
    }
};

export const sendMail = async (config: Config, logger: Logger, mail: Mail): Promise<MailDelivery> => {
    if (config.email.apiKey === `` || config.email.from === ``) {
        logger.warn({ to: mail.to, link: mail.link }, `email unconfigured — logging link instead of sending`);
        return `unconfigured`;
    }
    if (resolvesOnlyHere(mail.link)) {
        logger.warn({ to: mail.to, link: mail.link }, `link resolves only on this machine — not emailing it`);
        return `local-link`;
    }
    const response = await fetch(`https://api.resend.com/emails`, {
        method: `POST`,
        headers: { authorization: `Bearer ${config.email.apiKey}`, "content-type": `application/json` },
        body: JSON.stringify({ from: config.email.from, to: mail.to, subject: mail.subject, html: mail.html }),
    });
    if (!response.ok) {
        throw new Error(`Resend rejected the email (${response.status}): ${await response.text()}`);
    }
    return `sent`;
};
