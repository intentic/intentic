import type { Config } from "./config.js";
import type { Logger } from "pino";

/* The platform's transactional mail, and every piece of it that is not the wording.
 *
 * Both mails it sends are the same object — one link, and the sentence that says why it arrived: an invite to
 * someone else's sandbox, and a way back to a setup that has to be finished on a different machine. So the
 * frame and the transport live here and the two callers own only their words.
 *
 * Talks to Resend's HTTP API directly (no SDK — a single authenticated POST, like cloudflare.ts). When email is
 * unconfigured the link is LOGGED instead of sent, so both flows still work on a dev machine with no mail
 * credentials; a non-2xx propagates, so the mutation that sent the mail fails and the caller can retry.
 */
export interface Mail {
    to: string;
    subject: string;
    /* The link the mail exists to deliver. Its own field rather than something to dig back out of `html`,
     * because it is exactly what the unconfigured-dev branch logs — a developer reads it out of the server
     * output and carries on with the flow by hand. */
    link: string;
    html: string;
}

// The shared frame: a heading, a sentence, the button, and the same link again as text. The last part is not
// decoration — a mail client that strips the anchor, or a reader forwarding this to the machine it is meant
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

export const sendMail = async (config: Config, logger: Logger, mail: Mail): Promise<void> => {
    if (config.email.apiKey === `` || config.email.from === ``) {
        logger.warn({ to: mail.to, link: mail.link }, `email unconfigured — logging link instead of sending`);
        return;
    }
    const response = await fetch(`https://api.resend.com/emails`, {
        method: `POST`,
        headers: { authorization: `Bearer ${config.email.apiKey}`, "content-type": `application/json` },
        body: JSON.stringify({ from: config.email.from, to: mail.to, subject: mail.subject, html: mail.html }),
    });
    if (!response.ok) {
        throw new Error(`Resend rejected the email (${response.status}): ${await response.text()}`);
    }
};
