import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mirrorLogPath } from "./config.js";
import type { Log } from "./mirror.js";

// Login autostart for the port-mirror watcher, so mirroring resumes after a reboot with no user action — the
// same guarantee Mutagen's own daemon gets from `mutagen daemon register`. Each OS has its own mechanism
// (launchd on macOS, Task Scheduler on Windows, an XDG autostart entry on Linux desktops), all registered to
// run `intentic-sync mirror --watch` at login. Best-effort throughout: the current session is always covered by
// a detached spawn regardless (see startMirrorWatcher), so a registration failure only costs reboot-resume.

const LABEL = "dev.intentic.sync-mirror";
const WINDOWS_TASK = "IntenticSyncMirror";

const macPlistPath = (): string => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const linuxDesktopPath = (): string => join(homedir(), ".config", "autostart", "intentic-sync-mirror.desktop");

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// The launchd LaunchAgent: RunAtLoad starts it at login (and at bootstrap time), stdout/stderr to mirror.log.
// No KeepAlive — a deliberate `--stop` should stay stopped, and this session is separately covered.
export const macPlistXml = (cliPath: string): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${process.execPath}</string>
        <string>${cliPath}</string>
        <string>mirror</string>
        <string>--watch</string>
    </array>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>${mirrorLogPath}</string>
    <key>StandardErrorPath</key><string>${mirrorLogPath}</string>
</dict>
</plist>
`;

// An XDG autostart desktop entry — started by the desktop session at graphical login. Args with spaces are
// double-quoted per the desktop-entry Exec grammar. (Headless/WSL sessions have no autostart; same limitation
// class as Mutagen's Linux no-op — the note on failure/absence covers it.)
export const linuxDesktopEntry = (cliPath: string): string =>
    `[Desktop Entry]
Type=Application
Name=Intentic Sync Mirror
Comment=Mirror the intentic sandbox's workspace ports onto localhost
Exec="${process.execPath}" "${cliPath}" mirror --watch
X-GNOME-Autostart-enabled=true
`;

// The schtasks argv registering an ONLOGON task. /TR is one string; Node's Windows arg-quoting wraps it so
// schtasks receives the intended `"node" "cli" mirror --watch`.
export const windowsTaskArgs = (cliPath: string): string[] => [
    "/Create",
    "/TN",
    WINDOWS_TASK,
    "/SC",
    "ONLOGON",
    "/F",
    "/TR",
    `"${process.execPath}" "${cliPath}" mirror --watch`,
];

const registerMac = async (cliPath: string): Promise<boolean> => {
    const plist = macPlistPath();
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, macPlistXml(cliPath), { mode: 0o644 });
    const uid = process.getuid?.() ?? 0;
    // Reload cleanly: bootout any prior instance, then bootstrap (modern launchctl). Bootstrap loads + starts it
    // now (RunAtLoad), so the caller skips its own spawn. Fall back to legacy `load -w` on older macOS.
    spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
    if (spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "ignore" }).status === 0) {
        return true;
    }
    return spawnSync("launchctl", ["load", "-w", plist], { stdio: "ignore" }).status === 0;
};

const registerLinux = async (cliPath: string): Promise<void> => {
    const file = linuxDesktopPath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, linuxDesktopEntry(cliPath), { mode: 0o644 });
};

const registerWindows = (cliPath: string): void => {
    if (spawnSync("schtasks", windowsTaskArgs(cliPath), { stdio: "ignore" }).status !== 0) {
        throw new Error("schtasks /Create failed");
    }
};

// Register the watcher to start at login. Returns true only when the OS mechanism ALSO launched it for the
// CURRENT session (macOS bootstrap) — so the caller can skip its own detached spawn and avoid a double watcher.
// Windows/Linux autostart fire only at the next login, so they return false and the caller covers this session.
export const registerAutostart = async (cliPath: string, log: Log): Promise<boolean> => {
    try {
        if (process.platform === "darwin") {
            return await registerMac(cliPath);
        }
        if (process.platform === "win32") {
            registerWindows(cliPath);
        } else if (process.platform === "linux") {
            await registerLinux(cliPath);
        }
    } catch (error) {
        log(
            `note: couldn't register port mirroring to resume on login (${reason(error)}); it runs until this machine restarts — then re-run \`intentic-sync mirror\`.`,
        );
    }
    return false;
};

// Remove the login-autostart entry (and, on macOS, stop the launchd-run instance). Idempotent + best-effort.
export const unregisterAutostart = async (log: Log): Promise<void> => {
    try {
        if (process.platform === "darwin") {
            const uid = process.getuid?.() ?? 0;
            spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
            spawnSync("launchctl", ["unload", macPlistPath()], { stdio: "ignore" });
            await rm(macPlistPath(), { force: true });
        } else if (process.platform === "win32") {
            spawnSync("schtasks", ["/Delete", "/TN", WINDOWS_TASK, "/F"], { stdio: "ignore" });
        } else if (process.platform === "linux") {
            await rm(linuxDesktopPath(), { force: true });
        }
    } catch (error) {
        log(`note: couldn't remove the login-autostart entry for port mirroring (${reason(error)}).`);
    }
};
