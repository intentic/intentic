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
    // Mailed even when the link resolves only here: a sign-in code is for the person at this machine, who asked for it
    // from a page this machine served, and the code in the mail works wherever the link does not.
    forThisMachine?: boolean;
}

// Text from outside (a machine's failure message, a name the owner typed) goes into a mail as text, never as markup.
const HTML_ENTITIES = new Map([
    [`&`, `&amp;`],
    [`<`, `&lt;`],
    [`>`, `&gt;`],
    [`"`, `&quot;`],
    [`'`, `&#39;`],
]);
export const escapeHtml = (text: string): string => text.replace(/[&<>"']/g, (char) => HTML_ENTITIES.get(char) ?? char);

// The shared frame; the link is repeated as plain text since a stripped anchor or a forwarded mail still needs it.
// `details` is markup placed between the body and the button, `aside` between the button and the plain link: a mail
// with more to say than one sentence keeps the same frame instead of growing its own.
export const linkEmail = (mail: { heading: string; body: string; action: string; link: string; details?: string; aside?: string }): string => `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 30rem; margin: 0 auto; color: #1a1a1a;">
        <h2 style="font-size: 1.25rem; font-weight: 600;">${mail.heading}</h2>
        <p style="color: #555; line-height: 1.5;">${mail.body}</p>${mail.details ?? ``}
        <p style="margin: 1.5rem 0;">
            <a href="${mail.link}" style="background: #4f46e5; color: #fff; padding: 0.6rem 1.1rem; border-radius: 0.5rem; text-decoration: none; font-weight: 600;">
                ${mail.action}
            </a>
        </p>${mail.aside ?? ``}
        <p style="color: #888; font-size: 0.8rem;">Or paste this link into your browser:<br />${mail.link}</p>
    </div>
`;

// The sign-in mail: one code, offered two ways. Typed into the page that asked for it, or opened from the link, whose
// page asks for a Confirm press before it signs in, so a mail scanner that opens every link uses nothing up.
export const signInCodeEmail = (mail: { code: string; link: string; minutes: number }): string => `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 30rem; margin: 0 auto; color: #1a1a1a;">
        <h2 style="font-size: 1.25rem; font-weight: 600;">Your intentic sign-in code</h2>
        <p style="color: #555; line-height: 1.5;">Type this code on the page where you asked for it:</p>
        <p style="font-size: 2rem; font-weight: 700; letter-spacing: 0.3rem; margin: 1rem 0;">${escapeHtml(mail.code)}</p>
        <p style="color: #555; line-height: 1.5;">Or sign in on this device:</p>
        <p style="margin: 1.5rem 0;">
            <a href="${escapeHtml(mail.link)}" style="background: #4f46e5; color: #fff; padding: 0.6rem 1.1rem; border-radius: 0.5rem; text-decoration: none; font-weight: 600;">
                Sign in to intentic
            </a>
        </p>
        <p style="color: #888; font-size: 0.8rem;">The code works once and for ${mail.minutes} minutes. If you did not ask for it, ignore this mail: nobody can sign in without the code.</p>
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
    if (mail.forThisMachine !== true && resolvesOnlyHere(mail.link)) {
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
