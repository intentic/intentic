import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { mirrorLogPath } from "./config.js";
import type { CliLauncher, Log } from "./mirror.js";

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

// The full argv every autostart mechanism registers: how to re-invoke this CLI, then the watch command.
const watchArgv = (launcher: CliLauncher): string[] => [...launcher, "mirror", "--watch"];

// The same argv as ONE command string, for the mechanisms that take a command line rather than an array
// (the XDG Exec key, schtasks /TR). Every element is quoted — installed paths routinely contain spaces
// (C:\Users\First Last\…, /Users/first last/…).
const quotedArgv = (launcher: CliLauncher): string =>
    watchArgv(launcher)
        .map((arg) => `"${arg}"`)
        .join(" ");

// The launchd LaunchAgent: RunAtLoad starts it at login (and at bootstrap time), stdout/stderr to mirror.log.
// No KeepAlive — a deliberate `--stop` should stay stopped, and this session is separately covered.
export const macPlistXml = (launcher: CliLauncher): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
${watchArgv(launcher)
    .map((arg) => `        <string>${arg}</string>`)
    .join("\n")}
    </array>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>${mirrorLogPath}</string>
    <key>StandardErrorPath</key><string>${mirrorLogPath}</string>
</dict>
</plist>
`;

// An XDG autostart desktop entry — started by the desktop session at graphical login. Exec args are quoted per
// the desktop-entry grammar. (Headless/WSL sessions have no autostart; same limitation class as Mutagen's Linux
// no-op — the note on failure/absence covers it.)
export const linuxDesktopEntry = (launcher: CliLauncher): string =>
    `[Desktop Entry]
Type=Application
Name=Intentic Sync Mirror
Comment=Mirror the intentic sandbox's workspace ports onto localhost
Exec=${quotedArgv(launcher)}
X-GNOME-Autostart-enabled=true
`;

// The schtasks argv registering an ONLOGON task. /TR is one string; Node's Windows arg-quoting wraps it so
// schtasks receives the intended `"<launcher…>" "mirror" "--watch"`.
export const windowsTaskArgs = (launcher: CliLauncher): string[] => [
    "/Create",
    "/TN",
    WINDOWS_TASK,
    "/SC",
    "ONLOGON",
    "/F",
    "/TR",
    quotedArgv(launcher),
];

const registerMac = async (launcher: CliLauncher): Promise<boolean> => {
    const plist = macPlistPath();
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, macPlistXml(launcher), { mode: 0o644 });
    const uid = process.getuid?.() ?? 0;
    // Reload cleanly: bootout any prior instance, then bootstrap (modern launchctl). Bootstrap loads + starts it
    // now (RunAtLoad), so the caller skips its own spawn. Fall back to legacy `load -w` on older macOS.
    spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
    if (spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "ignore" }).status === 0) {
        return true;
    }
    return spawnSync("launchctl", ["load", "-w", plist], { stdio: "ignore" }).status === 0;
};

const registerLinux = async (launcher: CliLauncher): Promise<void> => {
    const file = linuxDesktopPath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, linuxDesktopEntry(launcher), { mode: 0o644 });
};

const registerWindows = (launcher: CliLauncher): void => {
    if (spawnSync("schtasks", windowsTaskArgs(launcher), { stdio: "ignore" }).status !== 0) {
        throw new Error("schtasks /Create failed");
    }
};

// Register the watcher to start at login. Returns true only when the OS mechanism ALSO launched it for the
// CURRENT session (macOS bootstrap) — so the caller can skip its own detached spawn and avoid a double watcher.
// Windows/Linux autostart fire only at the next login, so they return false and the caller covers this session.
export const registerAutostart = async (launcher: CliLauncher, log: Log): Promise<boolean> => {
    try {
        if (process.platform === "darwin") {
            return await registerMac(launcher);
        }
        if (process.platform === "win32") {
            registerWindows(launcher);
        } else if (process.platform === "linux") {
            await registerLinux(launcher);
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
