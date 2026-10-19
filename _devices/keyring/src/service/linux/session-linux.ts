import { linuxChoicePrompt, linuxPassphrasePrompt, linuxValuePrompt } from "../../consent/consent-posix.js";
import type { Runner } from "../../run.js";
import { platformTypist } from "../../typing/index.js";
import type { SessionPlatform } from "../helper.js";
import { linuxServicePaths } from "./paths-linux.js";
import { serviceUserId } from "../user.js";

// The session helper on Linux: the door under /run/intentic-keyring/<uid>, zenity or kdialog for its boxes. There is no
// Windows Hello; a yes is polkit's, which the service asks for itself (polkit-linux.ts), so the helper only names its pid.

export const linuxSession = async (runner: Runner): Promise<SessionPlatform> => {
    const paths = linuxServicePaths(await serviceUserId(runner, "linux"));
    return {
        doorFile: paths.door,
        noService: `Passwords' service is not running: \`systemctl status ${paths.unitName}\` says why.`,
        hands: { hello: undefined, passphrase: linuxPassphrasePrompt(runner), value: linuxValuePrompt(runner), choose: linuxChoicePrompt(runner), typist: platformTypist(runner) },
    };
};
