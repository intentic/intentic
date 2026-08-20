import type { Config } from "../config.js";
import type { Logger } from "pino";
import { linkEmail, type MailDelivery, sendMail } from "../mail.js";

// The invite mail: an accept link for a sandbox somebody else owns, built from webOrigin. Everything that is
// not the wording. Resend, the unconfigured-dev fallback, the frame around the words, belongs to mail.ts.
//
// The LINK is minted separately (`inviteLink`) because it outlives the mail: it is what the route hands back to
// the owner, so an invite whose mail was declined or refused is still an invite they can pass on by hand.
export interface InviteEmail {
    to: string;
    sandboxName: string;
    inviterName: string;
    link: string;
}

export const inviteLink = (config: Config, token: string): string => `${config.webOrigin}/invite/${token}`;

export const sendInviteEmail = async (config: Config, logger: Logger, invite: InviteEmail): Promise<MailDelivery> =>
    sendMail(config, logger, {
        to: invite.to,
        subject: `${invite.inviterName} invited you to the "${invite.sandboxName}" sandbox`,
        link: invite.link,
        html: linkEmail({
            heading: `${invite.inviterName} invited you to a sandbox`,
            body: `You've been invited to open and work in the <strong>${invite.sandboxName}</strong> sandbox on intentic.
            Accept below and sign in with your Google account (${invite.to}).`,
            action: `Accept invitation`,
            link: invite.link,
        }),
    });
