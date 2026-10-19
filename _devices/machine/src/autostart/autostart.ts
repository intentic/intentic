import { keyringPaths } from "@intentic/keyring";
import type { AutostartSpec } from "@intentic/local-agent";
import { runLogPath } from "../config.js";

// One autostart entry for the resident agent serving both device and sync. Mechanisms live in @intentic/local-agent;
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
    // What Windows' boot task runs (`intentic-machine before-sign-in on`): the agent with no desktop, until a sign-in.
    beforeSignInArgs: ["run", "--foreground", "--before-sign-in"],
    failureNote: (reason) =>
        `Couldn't register this device's agent to start at login (${reason}); it runs until this device restarts, and starts again with intentic-machine run. Its log is ${runLogPath}.`,
};

// The keyring's own entry (keyring/service.ts): a process of its own beside this agent, started at login and kept running
// by the same mechanisms, under names of its own so neither entry replaces the other. Since 2026-10-19 what starts is
// the session helper (`session`): the vault is held by Passwords' protected service (a LOCAL SERVICE task on Windows, a
// systemd system unit on Linux), and the helper shows its prompts, does its typing and answers the user's pipe. A login
// entry left from before ran `serve`; registering this one replaces it, since both carry the same names.
const keyringLog = keyringPaths().log;

export const KEYRING_AUTOSTART: AutostartSpec = {
    id: "keyring",
    windowsRunValue: "IntenticKeyring",
    desktopName: "Intentic Passwords",
    desktopComment: "Passwords on this computer: its prompts and typing on this desktop, for the protected service that holds the vault",
    logPath: keyringLog,
    launchAgent: { label: "dev.intentic.keyring" },
    detachedArgs: ["session"],
    foregroundArgs: ["session"],
    failureNote: (reason) =>
        `Couldn't register Passwords to start at login (${reason}); it runs until this computer restarts, and \`intentic-machine keyring setup\` starts it again. Its log is ${keyringLog}.`,
};
