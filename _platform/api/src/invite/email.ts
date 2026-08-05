import type { Config } from "../config.js";
import type { Logger } from "pino";
import { linkEmail, sendMail } from "../mail.js";

// The invite mail: an accept link for a sandbox somebody else owns, built from webOrigin. Everything that is
// not the wording — Resend, the unconfigured-dev fallback, the frame around the words — belongs to mail.ts.
export interface InviteEmail {
    to: string;
    sandboxName: string;
    inviterName: string;
    token: string;
}

export const sendInviteEmail = async (config: Config, logger: Logger, invite: InviteEmail): Promise<void> => {
    const link = `${config.webOrigin}/invite/${invite.token}`;
    await sendMail(config, logger, {
        to: invite.to,
        subject: `${invite.inviterName} invited you to the "${invite.sandboxName}" sandbox`,
        link,
        html: linkEmail({
            heading: `${invite.inviterName} invited you to a sandbox`,
            body: `You've been invited to open and work in the <strong>${invite.sandboxName}</strong> sandbox on intentic.
            Accept below and sign in with your Google account (${invite.to}).`,
            action: `Accept invitation`,
            link,
        }),
    });
};
