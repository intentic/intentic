import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Log, mirrorLogPath } from "./config.js";
import type { CliLauncher } from "./mirror.js";

// Login autostart for the port-mirror watcher, so mirroring resumes after a reboot with no user action — the
// same guarantee Mutagen's own daemon gets from `mutagen daemon register`, and on Windows by the very same
// mechanism (see WINDOWS_RUN_KEY). Each OS has its own: launchd on macOS, the per-user Run key on Windows, an
// XDG autostart entry on Linux desktops. Best-effort throughout: the current session is always covered by a
// detached spawn regardless (see startMirrorWatcher), so a registration failure only costs reboot-resume.

const LABEL = "dev.intentic.sync-mirror";

// Windows autostart lives in this user's OWN registry hive, which is why it needs no elevation and no
// password. Task Scheduler was the wrong tool twice over, and it failed on every non-elevated shell: `/SC
// ONLOGON` registers a trigger for "whenever a user (ANY user) logs on" — a machine-wide change — and
// schtasks "always prompts for a password ... even when you schedule a task on the local computer using the
// current user account", which against a spawn's empty stdin can only fail. Mutagen writes
// `"<mutagen.exe>" daemon start` to this exact key, and its registration kept succeeding in the same runs
// where ours died.
const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE = "IntenticSyncMirror";

const macPlistPath = (): string => join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const linuxDesktopPath = (): string => join(homedir(), ".config", "autostart", "intentic-sync-mirror.desktop");

// reg.exe by absolute path: PATH is not ours to trust for a program that edits the registry, and a spawn that
// can't find its command fails indistinguishably from one that ran and refused.
const regExe = (): string => join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "reg.exe");

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Run a registration tool and fail with what it ACTUALLY said. These calls used to be `stdio: "ignore"` plus
// an exit-code check, which reduced every failure to a guess we wrote ourselves: the note read "schtasks
// /Create failed" for three sandboxes running while the tool had a one-line reason to give. Which stream
// carries that reason is the tool's business (schtasks answers on stdout, launchctl on stderr), so both are
// kept, and a spawn that never ran hands back its own error rather than a status of null.
const register = (command: string, args: readonly string[]): void => {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        const said = `${result.stdout}${result.stderr}`.trim();
        throw new Error(said === "" ? `${basename(command)} exited ${result.status}` : said);
    }
};

// The watcher loop in the foreground — what an autostart mechanism that SUPERVISES the process it starts
// (launchd, the XDG desktop session) should run.
const watchArgv = (launcher: CliLauncher): string[] => [...launcher, "mirror", "--watch"];

// An argv as ONE command line, for the mechanisms that take a string rather than an array (the XDG Exec key,
// a Run value). Every element is quoted — installed paths routinely contain spaces (C:\Users\First Last\…,
// /Users/first last/…).
const quoted = (argv: readonly string[]): string => argv.map((arg) => `"${arg}"`).join(" ");

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
Exec=${quoted(watchArgv(launcher))}
X-GNOME-Autostart-enabled=true
`;

// `reg add … /f` overwrites whatever is there, so a re-run after the agent moves re-points the entry. The
// value runs `mirror`, NOT `mirror --watch`: Explorer starts a Run entry in the interactive session, where a
// console program owns a console window for as long as it lives, so registering the foreground loop would
// park a black window on the desktop from login until shutdown. Bare `mirror` starts the detached (and
// hidden) watcher and exits within a second — exactly the shape of Mutagen's own `daemon start` entry.
export const windowsRunAddArgs = (launcher: CliLauncher): string[] => [
    "add",
    WINDOWS_RUN_KEY,
    "/v",
    WINDOWS_RUN_VALUE,
    "/t",
    "REG_SZ",
    "/d",
    quoted([...launcher, "mirror"]),
    "/f",
];

export const windowsRunDeleteArgs = (): string[] => ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"];

const registerMac = async (launcher: CliLauncher): Promise<boolean> => {
    const plist = macPlistPath();
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, macPlistXml(launcher), { mode: 0o644 });
    const uid = process.getuid?.() ?? 0;
    // Reload cleanly: bootout any prior instance, then bootstrap (modern launchctl). Bootstrap loads + starts it
    // now (RunAtLoad), so the caller skips its own spawn. Fall back to legacy `load -w` on older macOS, which
    // RunAtLoad starts too — and which reports why if IT fails, since nothing else is left to try.
    spawnSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
    if (spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "ignore" }).status === 0) {
        return true;
    }
    register("launchctl", ["load", "-w", plist]);
    return true;
};

const registerLinux = async (launcher: CliLauncher): Promise<void> => {
    const file = linuxDesktopPath();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, linuxDesktopEntry(launcher), { mode: 0o644 });
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
            register(regExe(), windowsRunAddArgs(launcher));
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
            // `reg delete` exits non-zero when the value is already gone, which is the normal case for a second
            // `--stop` — ignoring that is this branch's `rm --force`.
            spawnSync(regExe(), windowsRunDeleteArgs(), { stdio: "ignore" });
        } else if (process.platform === "linux") {
            await rm(linuxDesktopPath(), { force: true });
        }
    } catch (error) {
        log(`note: couldn't remove the login-autostart entry for port mirroring (${reason(error)}).`);
    }
};
