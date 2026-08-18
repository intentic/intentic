import type { AutostartSpec } from "@intentic/local-agent";
import { runLogPath } from "./config.js";

/* How this agent asks to be started again at login. The mechanisms, their per-OS gotchas and the best-effort
 * error handling all live in @intentic/local-agent — what is here is only what is true of THIS agent.
 *
 * No `launchAgent`: the connection loop has never been exercised on macOS, so it declares no autostart there and
 * says so, rather than writing an XDG entry macOS does not read (which is what this file used to do). Opting in
 * is one line — a reverse-DNS label — once someone has run it on a Mac; the log path is declared below already,
 * because every supervising mechanism needs it, not just launchd. */
export const HOST_AUTOSTART: AutostartSpec = {
    id: "intentic-host",
    windowsRunValue: "IntenticHost",
    desktopName: "Intentic Host",
    desktopComment: "Let your intentic sandbox work on this computer",
    // The log this agent's own failure note points at — so a supervised run writes there too, rather than into a
    // journal the note never mentions.
    logPath: runLogPath,
    detachedArgs: ["run"],
    foregroundArgs: ["run", "--foreground"],
    failureNote: (reason) =>
        `note: couldn't register this computer to reconnect at login (${reason}); it stays connected until the machine restarts. Logs: ${runLogPath}`,
};
