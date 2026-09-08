import type { Config } from "../config.js";
import type { Logger } from "pino";
import { linkEmail, sendMail } from "../mail.js";

// Mails the setup link to bounce a phone user to a laptop that can run the install command. Carries no credential: just
// a session-gated URL that resumes this sandbox (sandboxId in the query, Setup.vue's onMounted), worth nothing to
// anyone but the signed-in owner.
export interface SetupLinkEmail {
    to: string;
    sandboxName: string;
    sandboxId: string;
}

export const sendSetupLinkEmail = async (config: Config, logger: Logger, setup: SetupLinkEmail): Promise<void> => {
    const link = `${config.webOrigin}/setup?sandbox=${encodeURIComponent(setup.sandboxId)}`;
    await sendMail(config, logger, {
        to: setup.to,
        subject: `Finish setting up your "${setup.sandboxName}" sandbox`,
        link,
        html: linkEmail({
            heading: `Finish setting up "${setup.sandboxName}"`,
            // Names the machine: the reader knows what they were doing, just not which device to do it on.
            body: `Open this on the computer that will host your sandbox, a laptop, a desktop, or a server you
            have a shell on. Your install command is waiting on the other side, ready to copy into a terminal.`,
            action: `Open setup`,
            link,
        }),
    });
};
