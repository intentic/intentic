import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type Log, runLogPath } from "./config.js";

/* Login autostart, so the computer is reachable again after a reboot without anyone remembering to start
 * anything. Best-effort throughout: `setup` starts this session's connection itself regardless, so a failed
 * registration costs reboot-resume and nothing else — and it says so rather than failing the install.
 *
 * The mechanisms are the user's own, per platform, and both are chosen for the same reason: no elevation, no
 * password prompt, no machine-wide change.
 *   Windows — the per-user Run key. (Task Scheduler was tried by the sync agent and rejected: `/SC ONLOGON` is a
 *             machine-wide trigger and schtasks demands a password even for the current user, which against a
 *             spawn's empty stdin can only fail.)
 *   Linux   — an XDG autostart entry, started by the desktop session at graphical login. A headless box has no
 *             desktop session and therefore no autostart; the note on registration says so, and `systemd-run
 *             --user` is the answer there. */

const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const WINDOWS_RUN_VALUE = "IntenticHost";
const linuxDesktopPath = (): string => join(homedir(), ".config", "autostart", "intentic-host.desktop");

// reg.exe by absolute path: PATH is not ours to trust for a program that edits the registry, and a spawn that
// can't find its command fails indistinguishably from one that ran and refused.
const regExe = (): string => join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "reg.exe");

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Run a registration tool and fail with what it ACTUALLY said — both streams, because which one carries the
// reason is the tool's business.
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

// How to re-launch this CLI: the executable, plus any leading argument that must precede the command. A compiled
// binary IS the CLI and re-injects its own entry; `node dist/cli.js` needs the script path. Passing the entry to
// a compiled binary pushes the command name to argv[2], where the parser never looks — the sync agent shipped
// that bug and its autostart entries were persisted broken.
export type CliLauncher = readonly [string, ...string[]];

const isBunVirtualEntry = (entry: string): boolean => entry.includes("$bunfs") || entry.includes("~BUN");

export const cliLauncher = (): CliLauncher => {
    const entry = process.argv[1];
    if (entry === undefined) {
        throw new Error("cannot locate the intentic-host entry to register for autostart");
    }
    return isBunVirtualEntry(entry) ? [process.execPath] : [process.execPath, entry];
};

// Every element quoted — installed paths routinely contain spaces (C:\Users\First Last\…).
const quoted = (argv: readonly string[]): string => argv.map((arg) => `"${arg}"`).join(" ");

// `run` (detached) rather than `run --foreground`: Explorer starts a Run entry in the interactive session, where
// a console program owns a console window for as long as it lives — registering the foreground loop would park
// a black window on the desktop from login until shutdown.
export const windowsRunAddArgs = (launcher: CliLauncher): string[] => [
    "add",
    WINDOWS_RUN_KEY,
    "/v",
    WINDOWS_RUN_VALUE,
    "/t",
    "REG_SZ",
    "/d",
    quoted([...launcher, "run"]),
    "/f",
];

export const windowsRunDeleteArgs = (): string[] => ["delete", WINDOWS_RUN_KEY, "/v", WINDOWS_RUN_VALUE, "/f"];

// The desktop session supervises what it starts, so this one runs the loop in the foreground.
export const linuxDesktopEntry = (launcher: CliLauncher): string =>
    `[Desktop Entry]
Type=Application
Name=Intentic Host
Comment=Let your intentic sandbox work on this computer
Exec=${quoted([...launcher, "run", "--foreground"])}
X-GNOME-Autostart-enabled=true
`;

export const registerAutostart = async (launcher: CliLauncher, log: Log): Promise<void> => {
    try {
        if (process.platform === "win32") {
            register(regExe(), windowsRunAddArgs(launcher));
            return;
        }
        const file = linuxDesktopPath();
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, linuxDesktopEntry(launcher), { mode: 0o644 });
        if (process.env["XDG_CURRENT_DESKTOP"] === undefined) {
            log(
                `note: this machine has no desktop session, so the autostart entry won't fire. To keep it connected: systemd-run --user --unit=intentic-host ${quoted([...launcher, "run", "--foreground"])}`,
            );
        }
    } catch (error) {
        log(
            `note: couldn't register this computer to reconnect at login (${reason(error)}); it stays connected until the machine restarts. Logs: ${runLogPath}`,
        );
    }
};

export const unregisterAutostart = async (log: Log): Promise<void> => {
    try {
        if (process.platform === "win32") {
            // `reg delete` exits non-zero when the value is already gone, which is the normal case for a second
            // uninstall — ignoring that is this branch's `rm --force`.
            spawnSync(regExe(), windowsRunDeleteArgs(), { stdio: "ignore" });
            return;
        }
        await rm(linuxDesktopPath(), { force: true });
    } catch (error) {
        log(`note: couldn't remove the login-autostart entry (${reason(error)}).`);
    }
};
