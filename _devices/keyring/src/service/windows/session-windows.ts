import { windowsChoicePrompt, windowsHello, windowsPassphrasePrompt, windowsValuePrompt } from "../../consent/consent-windows.js";
import type { Runner } from "../../run.js";
import { platformTypist } from "../../typing/index.js";
import type { SessionPlatform } from "../helper.js";
import { windowsServicePaths } from "./paths-windows.js";
import { currentSid } from "./sid-windows.js";

// The session helper on Windows: the door file under %ProgramData%, Windows Hello, and the WinForms boxes for the
// recovery key, the type-once box and the choice dialog (consent-windows.ts).

export const windowsSession = async (runner: Runner): Promise<SessionPlatform> => {
    const paths = windowsServicePaths(await currentSid(runner));
    return {
        doorFile: paths.door,
        noService: "Passwords' service is not running yet: it starts with Windows (Task Scheduler, \\Intentic\\).",
        hands: { hello: windowsHello(runner), passphrase: windowsPassphrasePrompt(runner), value: windowsValuePrompt(runner), choose: windowsChoicePrompt(runner), typist: platformTypist(runner) },
    };
};
