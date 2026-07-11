import type { Config } from "../config.js";
import type { Logger } from "pino";

// The only mail the platform sends: a sandbox invite link. Talks to Resend's HTTP API directly (no SDK — a
// single authenticated POST, like cloudflare.ts), building the accept-page link from webOrigin. When email is
// unconfigured (dev), the link is logged instead of sent so the flow still works; when configured, a non-2xx
// from Resend propagates (the invite mutation fails and the owner can retry via resend).
export interface InviteEmail {
    to: string;
    sandboxName: string;
    inviterName: string;
    token: string;
}

const inviteHtml = (invite: InviteEmail, link: string): string => `
    <div style="font-family: -apple-system, Segoe UI, Roboto, sans-serif; max-width: 30rem; margin: 0 auto; color: #1a1a1a;">
        <h2 style="font-size: 1.25rem; font-weight: 600;">${invite.inviterName} invited you to a sandbox</h2>
        <p style="color: #555; line-height: 1.5;">
            You've been invited to open and work in the <strong>${invite.sandboxName}</strong> sandbox on intentic.
            Accept below and sign in with your Google account (${invite.to}).
        </p>
        <p style="margin: 1.5rem 0;">
            <a href="${link}" style="background: #4f46e5; color: #fff; padding: 0.6rem 1.1rem; border-radius: 0.5rem; text-decoration: none; font-weight: 600;">
                Accept invitation
            </a>
        </p>
        <p style="color: #888; font-size: 0.8rem;">Or paste this link into your browser:<br />${link}</p>
    </div>
`;

export const sendInviteEmail = async (config: Config, logger: Logger, invite: InviteEmail): Promise<void> => {
    const link = `${config.webOrigin}/invite/${invite.token}`;
    if (config.email.apiKey === `` || config.email.from === ``) {
        logger.warn({ to: invite.to, link }, `email unconfigured — logging invite link instead of sending`);
        return;
    }
    const response = await fetch(`https://api.resend.com/emails`, {
        method: `POST`,
        headers: { authorization: `Bearer ${config.email.apiKey}`, "content-type": `application/json` },
        body: JSON.stringify({
            from: config.email.from,
            to: invite.to,
            subject: `${invite.inviterName} invited you to the "${invite.sandboxName}" sandbox`,
            html: inviteHtml(invite, link),
        }),
    });
    if (!response.ok) {
        throw new Error(`Resend rejected the invite email (${response.status}): ${await response.text()}`);
    }
};
