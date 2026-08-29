import type { AutostartSpec } from "@intentic/local-agent";
import { runLogPath } from "./config.js";

/* How this agent asks to be started again at login: ONE entry, for the one resident loop that serves both
 * halves. The mechanisms, their per-OS gotchas and the best-effort error handling all live in
 * @intentic/local-agent (on Windows that includes the intentic-launch stub, so nothing flashes on the desktop
 * at boot); what is here is only what is true of THIS agent.
 *
 * The two agents this replaces each registered their own entry, which was two logon starts, two console
 * windows' worth of risk, and two things for an uninstall to forget. `launchAgent` is declared because the sync
 * half has always run on macOS; the computer half simply has no links there today (its capability cards offer
 * Windows and Linux), so on a Mac the loop serves sync alone. */
export const MACHINE_AUTOSTART: AutostartSpec = {
    id: "intentic-machine",
    windowsRunValue: "IntenticMachine",
    desktopName: "Intentic Machine Agent",
    desktopComment: "Connect this computer to your intentic sandboxes: agent access, file sync, port mirroring",
    // The log this agent's own failure notes point at, so a supervised run writes there too, rather than into a
    // journal the notes never mention.
    logPath: runLogPath,
    launchAgent: { label: "dev.intentic.machine" },
    detachedArgs: ["run"],
    foregroundArgs: ["run", "--foreground"],
    failureNote: (reason) =>
        `note: couldn't register this machine's agent to start at login (${reason}); it runs until this machine restarts, then re-run \`intentic-machine run\`. Logs: ${runLogPath}`,
};
