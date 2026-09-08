import type { AutostartSpec } from "@intentic/local-agent";
import { runLogPath } from "./config.js";

// One autostart entry for the resident loop serving both device and sync. Mechanisms live in @intentic/local-agent;
// launchAgent is declared because sync has always run on macOS, though device currently doesn't (Windows/Linux only),
// so a Mac install serves sync alone.
export const MACHINE_AUTOSTART: AutostartSpec = {
    id: "intentic-machine",
    windowsRunValue: "IntenticMachine",
    desktopName: "Intentic Machine Agent",
    desktopComment: "Connect this device to your intentic sandboxes: agent access, file sync, port mirroring",
    // Where this agent's failure notes point; a supervised run must write here too, not to a journal.
    logPath: runLogPath,
    launchAgent: { label: "dev.intentic.machine" },
    detachedArgs: ["run"],
    foregroundArgs: ["run", "--foreground"],
    failureNote: (reason) =>
        `note: couldn't register this machine's agent to start at login (${reason}); it runs until this machine restarts, then re-run \`intentic-machine run\`. Logs: ${runLogPath}`,
};
