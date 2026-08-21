import type { Config } from "../config.js";
import type { Logger } from "pino";
import { linkEmail, sendMail } from "../mail.js";

/* The setup link a user mails themselves, the way off a phone, which is where this whole mail comes from.
 *
 * Setup's third step hands over an install command, and a phone is the one device that cannot finish it: there
 * is no terminal to paste into, and the clipboard it copies to is not the clipboard of the machine that has to
 * run it. So the phone sends the only thing that DOES travel between devices, the address of the setup screen
 * itself, and the laptop picks up the same sandbox, at the same step, with the command already on it.
 *
 * IT CARRIES NO CREDENTIAL. Not the setup code, not the command, not the connect token. Mail is stored and
 * forwarded by people we have no relationship with, and a link that let its holder stand a sandbox up would be
 * exactly the kind of secret that must never ride one. What arrives is a URL to a session-gated page, useless
 * to anyone who cannot sign in as the owner, and to the owner it is worth the same as their own bookmark bar.
 *
 * The sandbox id is in the query so the page RESUMES that sandbox (Setup.vue's onMounted) rather than opening a
 * blank create form. A browser with no session yet is sent through /login first and loses the query on the way,
 * which costs nothing: the router's own setup gate lands a signed-in user with an unfinished sandbox on exactly
 * this screen anyway (setupGate.ts). The link is the shortcut, not the mechanism.
 */
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
            // Names the machine, because that is the entire content of this mail: the reader already knows what
            // they were doing, and the one thing they got wrong was which device to do it on.
            body: `Open this on the computer that will host your sandbox, a laptop, a desktop, or a server you
            have a shell on. Your install command is waiting on the other side, ready to copy into a terminal.`,
            action: `Open setup`,
            link,
        }),
    });
};
