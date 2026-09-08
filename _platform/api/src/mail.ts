import type { Config } from "./config.js";
import type { Logger } from "pino";

// Three outcomes, not two: sent, unconfigured (no Resend key, link logged instead), or local-link (would only resolve
// here). Talks to Resend's HTTP API directly; the caller decides what a decline means for its mutation.
export type MailDelivery = "sent" | "unconfigured" | "local-link";

export interface Mail {
    to: string;
    subject: string;
    // Its own field, not dug out of `html`: the unconfigured-dev branch logs exactly this for a developer to read.
    link: string;
    html: string;
}

// The shared frame; the link is repeated as plain text since a stripped anchor or a forwarded mail still needs it.
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

// A link that would only resolve on the machine that built it (loopback only, not a LAN address); mailing it strands
// the recipient, so this declines and keeps the link at the near end instead.
const resolvesOnlyHere = (link: string): boolean => {
    try {
        const host = new URL(link).hostname.replace(/^\[|]$/g, ``);
        return host === `localhost` || host.endsWith(`.localhost`) || host === `127.0.0.1` || host === `::1`;
    } catch {
        // Not a URL at all: not this function's complaint to make; the send below fails or succeeds on its own.
        return false;
    }
};

export const sendMail = async (config: Config, logger: Logger, mail: Mail): Promise<MailDelivery> => {
    if (config.email.apiKey === `` || config.email.from === ``) {
        logger.warn({ to: mail.to, link: mail.link }, `email unconfigured, logging link instead of sending`);
        return `unconfigured`;
    }
    if (resolvesOnlyHere(mail.link)) {
        logger.warn({ to: mail.to, link: mail.link }, `link resolves only on this machine, not emailing it`);
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
