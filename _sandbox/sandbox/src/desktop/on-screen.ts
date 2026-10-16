import { statSync } from "node:fs";

export const SCREEN_SOCKET = "/run/intentic/screen/wayland-0";

// Read when the desktop is described, not at daemon startup: sway can restart while the sandbox keeps running.
export const onScreenGuidance = (socket: string = SCREEN_SOCKET): string => {
    try {
        return statSync(socket).isSocket()
            ? " To show an app on the owner's own screen run `on-screen <command>`; you cannot see or screenshot it there, so check it on your own desktop first."
            : "";
    // allow(silent-catch): a missing or inaccessible host screen is not offered to the agent
    } catch {
        // No mount, a stopped session or an inaccessible socket all mean there is no owner's screen to offer.
        return "";
    }
};
