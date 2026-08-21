import type { AutostartSpec } from "@intentic/local-agent";
import { mirrorLogPath } from "./config.js";

/* How the port-mirror watcher asks to be started again at login, so mirroring resumes after a reboot with no
 * user action, the same guarantee Mutagen's own daemon gets from `mutagen daemon register`, and on Windows by
 * the very same mechanism. The mechanisms themselves, and every per-OS lesson behind them, live in
 * @intentic/local-agent; what is here is only what is true of THIS agent.
 *
 * The Windows Run value runs bare `mirror` (which spawns the hidden watcher and exits within a second, exactly
 * the shape of Mutagen's own `daemon start` entry), while launchd and the desktop session, which supervise what
 * they start, get `mirror --watch`. That split is `detachedArgs` vs `foregroundArgs`. */
export const MIRROR_AUTOSTART: AutostartSpec = {
    id: "intentic-sync-mirror",
    windowsRunValue: "IntenticSyncMirror",
    desktopName: "Intentic Sync Mirror",
    desktopComment: "Mirror the intentic sandbox's workspace ports onto localhost",
    // One log for this watcher however it was started, by hand, by launchd, or by the systemd user unit. The
    // file `status` and every note in this agent name is the file each of those mechanisms writes to.
    logPath: mirrorLogPath,
    launchAgent: { label: "dev.intentic.sync-mirror" },
    detachedArgs: ["mirror"],
    foregroundArgs: ["mirror", "--watch"],
    failureNote: (reason) =>
        `note: couldn't register port mirroring to resume on login (${reason}); it runs until this machine restarts, then re-run \`intentic-sync mirror\`.`,
};
