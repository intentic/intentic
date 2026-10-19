import { realRunner, type Runner } from "../run.js";
import { runSession } from "./helper.js";
import { installLinuxService, uninstallLinuxService } from "./linux/install-linux.js";
import { installService, uninstallService } from "./windows/install-windows.js";
import { UID_RE } from "./linux/paths-linux.js";
import { SID_RE } from "./windows/paths-windows.js";
import { runService } from "./service-run.js";
import { linuxServiceRun } from "./linux/service-run-linux.js";
import { windowsServiceRun } from "./windows/service-run-windows.js";
import { linuxSession } from "./linux/session-linux.js";
import { NOT_ON_MAC } from "./user.js";
import { windowsSession } from "./windows/session-windows.js";

// The protected service's commands, each for the platform it runs on (app.ts routes them): Windows and Linux have one;
// macOS and anything else get the sentence the desktop app shows too.


class ServiceUnsupported extends Error {
    constructor(platform: NodeJS.Platform) {
        super(platform === "darwin" ? NOT_ON_MAC : `Passwords' protected service is not built for ${platform}.`);
        this.name = "ServiceUnsupported";
    }
}

export const installHere = async (runner: Runner = realRunner, platform: NodeJS.Platform = process.platform): Promise<object> => {
    switch (platform) {
        case "win32":
            return await installService(runner);
        case "linux":
            return await installLinuxService(runner);
        default:
            throw new ServiceUnsupported(platform);
    }
};

export const uninstallHere = async (runner: Runner = realRunner, platform: NodeJS.Platform = process.platform): Promise<object> => {
    switch (platform) {
        case "win32":
            return await uninstallService(runner);
        case "linux":
            return await uninstallLinuxService(runner);
        default:
            throw new ServiceUnsupported(platform);
    }
};

/** Whether `user` names a user as this platform's service takes one: a SID on Windows, a uid on Linux. */
export const userIdFits = (user: string, platform: NodeJS.Platform = process.platform): boolean => (platform === "win32" ? SID_RE.test(user) : UID_RE.test(user));

export const runServiceHere = async (user: string, runner: Runner = realRunner, platform: NodeJS.Platform = process.platform): Promise<never> => {
    switch (platform) {
        case "win32":
            return await runService(windowsServiceRun(user, runner), runner);
        case "linux":
            return await runService(linuxServiceRun(user, runner), runner);
        default:
            throw new ServiceUnsupported(platform);
    }
};

export const runSessionHere = async (runner: Runner = realRunner, platform: NodeJS.Platform = process.platform): Promise<void> => {
    switch (platform) {
        case "win32":
            await runSession(windowsSession, runner);
            return;
        case "linux":
            await runSession(linuxSession, runner);
            return;
        default:
            throw new ServiceUnsupported(platform);
    }
};
