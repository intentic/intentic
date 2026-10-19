import { windowsHello } from "../consent/consent-windows.js";
import type { Runner } from "../run.js";
import { linuxServiceInstalled } from "./linux/paths-linux.js";
import { windowsServiceInstalled } from "./windows/paths-windows.js";
import { currentSid } from "./windows/sid-windows.js";

// Who the protected service is for, as each platform names a user: a security identifier on Windows (it names the
// vault's folder and the startup task), the numeric uid on Linux (it names the unit instance and the vault's folder).

// What setup and the desktop app say on a Mac, where there is no protected service yet.
export const NOT_ON_MAC = "Passwords needs the Intentic desktop app's protected service, which is not on macOS yet.";

export type ServicePlatform = "windows" | "linux" | "darwin";

export const servicePlatform = (platform: NodeJS.Platform = process.platform): ServicePlatform | undefined => {
    switch (platform) {
        case "win32":
            return "windows";
        case "linux":
            return "linux";
        case "darwin":
            return "darwin";
        default:
            return undefined;
    }
};

const currentUid = (): string => {
    const uid = process.getuid?.();
    if (uid === undefined) {
        throw new Error("this process has no user id to read");
    }
    return String(uid);
};

/** This user's id as the service on this platform names it. */
export const serviceUserId = async (runner: Runner, platform: NodeJS.Platform = process.platform): Promise<string> =>
    platform === "win32" ? await currentSid(runner) : currentUid();

/** Whether the protected service is installed for this user: its marker, which every user may read. */
export const serviceInstalledHere = async (runner: Runner, platform: NodeJS.Platform = process.platform): Promise<boolean> => {
    if (platform !== "win32" && platform !== "linux") {
        return false;
    }
    try {
        const id = await serviceUserId(runner, platform);
        return platform === "win32" ? windowsServiceInstalled(id) : linuxServiceInstalled(id);
    } catch {
        // allow(silent-catch): a user the system cannot name has no marker of its own, which reads as not installed
        return false;
    }
};

/** Whether Windows Hello can sign for this user, asked before anything is set up. Never on anything but Windows. */
export const helloHere = async (runner: Runner, platform: NodeJS.Platform = process.platform): Promise<boolean> => (platform === "win32" ? await windowsHello(runner).available() : false);
