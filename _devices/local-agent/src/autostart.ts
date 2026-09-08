import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { type CliLauncher, quotedCommandLine, stubCommand, WINDOWS_LAUNCH_STUB, windowsLaunchStub } from "./launcher.js";
import type { Log } from "./home.js";

// Registers login autostart, best-effort: a failed registration only costs resume-after-reboot since the current
// session already runs. Windows uses the per-user Run key via a launcher stub, macOS an optional LaunchAgent, Linux a
// systemd user unit falling back to an XDG entry; none need elevation or a password.

export interface LaunchAgentSpec {
    // Reverse-DNS id: what launchctl bootout/bootstrap address it by.
    readonly label: string;
}

export interface AutostartSpec {
    // The agent's slug: XDG file's base name and the systemd unit's name; not the launchd label (reverse-DNS).
    readonly id: string;
    // The log every mechanism writes to; matches what the agent's own status and docs name, not the journal.
    readonly logPath: string;
    // The value name under HKCU Run; must match what unregister deletes, or uninstall leaves it resurrecting.
    readonly windowsRunValue: string;
    // What the desktop session shows for the entry.
    readonly desktopName: string;
    readonly desktopComment: string;
    // Absent: no macOS autostart for this agent (see registerAutostart).
    readonly launchAgent?: LaunchAgentSpec;
    // foreground: args for mechanisms that supervise the loop. detached: Windows fallback, spawns and exits.
    readonly detachedArgs: readonly string[];
    readonly foregroundArgs: readonly string[];
    // What the user is told when registration fails; agent-specific, since what's lost and how to retry differs.
    readonly failureNote: (reason: string) => string;
}

const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const linuxDesktopPath = (spec: AutostartSpec): string => join(homedir(), ".config", "autostart", `${spec.id}.desktop`);
const macPlistPath = (agent: LaunchAgentSpec): string => join(homedir(), "Library", "LaunchAgents", `${agent.label}.plist`);

const systemdUnitName = (spec: AutostartSpec): string => `${spec.id}.service`;
const systemdUnitPath = (spec: AutostartSpec): string => join(homedir(), ".config", "systemd", "user", systemdUnitName(spec));

// Absolute path: PATH isn't trusted for a registry-editing tool, and a not-found spawn fails identically to a refusal.
const regExe = (): string => join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "reg.exe");

const reason = (error: unknown): string => errorMessage(error);

// Surfaces what the tool actually said instead of a generic exit-code guess. Checks both stdout and stderr (tools
// differ on which carries the message), and a spawn that never ran throws its own error.
const register = (command: string, args: readonly string[]): void => {
    const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
    if (result.error !== undefined) {
        throw result.error;
    }
    if (result.status !== 0) {
        const said = `${result.stdout}${result.stderr}`.trim();
        throw new Error(said === "" ? `${basename(command)} exited ${result.status}` : said);
    }
};

// `reg add .../f` overwrites the existing value. With a stub, wraps the foreground command through it (no visible
// window); without one, falls back to the detached command (a flashing console).
export const windowsRunAddArgs = (spec: AutostartSpec, launcher: CliLauncher, stub?: string): string[] =>
    windowsRunValueAddArgs(
        spec.windowsRunValue,
        quotedCommandLine(
            stub === undefined ? [...launcher, ...spec.detachedArgs] : stubCommand(stub, spec.logPath, [...launcher, ...spec.foregroundArgs]),
        ),
    );

export const windowsRunDeleteArgs = (spec: AutostartSpec): string[] => windowsRunValueDeleteArgs(spec.windowsRunValue);

// One per-user Run value. Exported because the sync agent also uses it to register Mutagen's daemon command here,
// avoiding the console flash Mutagen's own registration would cause.
export const windowsRunValueAddArgs = (name: string, commandLine: string): string[] => [
    "add",
    WINDOWS_RUN_KEY,
    "/v",
    name,
    "/t",
    "REG_SZ",
    "/d",
    commandLine,
    "/f",
];

export const windowsRunValueDeleteArgs = (name: string): string[] => ["delete", WINDOWS_RUN_KEY, "/v", name, "/f"];

// Throws with what reg.exe actually said.
export const setWindowsRunValue = (name: string, commandLine: string): void => register(regExe(), windowsRunValueAddArgs(name, commandLine));

// `reg delete` exits non-zero when the value is already gone; ignored here for a repeat uninstall.
export const clearWindowsRunValue = (name: string): void => {
    spawnSync(regExe(), windowsRunValueDeleteArgs(name), { stdio: "ignore", windowsHide: true });
};

// States meaning a user manager exists (degraded/starting count too); some Linux setups have none.
const SYSTEMD_LIVE_STATES = new Set(["running", "degraded", "starting", "maintenance", "stopping", "initializing"]);

const systemdUserAvailable = (): boolean => {
    const result = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" });
    if (result.error !== undefined) {
        return false; // no systemctl on PATH
    }
    // Non-zero exit is normal for "degraded"; the printed state decides, not the exit status.
    return SYSTEMD_LIVE_STATES.has(result.stdout.trim());
};

// Restart=on-failure keeps a deliberate stop stopped, but needs the agent to exit non-zero on a signal;
// RestartForceExitStatus forces a restart anyway for SIGHUP/INT/TERM/PIPE, which systemd otherwise treats as clean.
export const systemdUserUnit = (spec: AutostartSpec, launcher: CliLauncher): string => {
    return `[Unit]
Description=${spec.desktopName}: ${spec.desktopComment}
After=network-online.target

[Service]
Type=simple
ExecStart=${quotedCommandLine([...launcher, ...spec.foregroundArgs])}
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}
Restart=on-failure
RestartSec=5
RestartForceExitStatus=SIGHUP SIGINT SIGTERM SIGPIPE
StartLimitIntervalSec=0
Environment=PATH=${join(homedir(), ".local", "bin")}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
};

// `enable --now` both resumes at boot and starts the unit now, so the caller can skip its own spawn. Lingering keeps
// the user manager (and unit) alive without a session, or a headless box would never autostart.
const registerSystemdUser = async (spec: AutostartSpec, launcher: CliLauncher, log: Log): Promise<boolean> => {
    const unit = systemdUnitPath(spec);
    await mkdir(dirname(unit), { recursive: true });
    await writeFile(unit, systemdUserUnit(spec, launcher), { mode: 0o644 });
    spawnSync("loginctl", ["enable-linger"], { stdio: "ignore" });
    // daemon-reload so a rewritten unit is picked up, not the version systemd already parsed.
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    register("systemctl", ["--user", "enable", "--now", systemdUnitName(spec)]);
    // Named by its own log file, not the journal; see systemdUserUnit.
    log(`registered ${systemdUnitName(spec)} to run now and at boot. Follow it with: tail -f ${spec.logPath}`);
    return true;
};

// Exec args are quoted per the desktop-entry grammar.
export const linuxDesktopEntry = (spec: AutostartSpec, launcher: CliLauncher): string =>
    `[Desktop Entry]
Type=Application
Name=${spec.desktopName}
Comment=${spec.desktopComment}
Exec=${quotedCommandLine([...launcher, ...spec.foregroundArgs])}
X-GNOME-Autostart-enabled=true
`;

// RunAtLoad starts it at login; no KeepAlive, so a deliberate stop stays stopped. The current session is covered
// separately by the caller.
export const macLaunchAgentXml = (spec: AutostartSpec, agent: LaunchAgentSpec, launcher: CliLauncher): string =>
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key><string>${agent.label}</string>
    <key>ProgramArguments</key>
    <array>
${[...launcher, ...spec.foregroundArgs].map((arg) => `        <string>${arg}</string>`).join("\n")}
    </array>
    <key>RunAtLoad</key><true/>
    <key>StandardOutPath</key><string>${spec.logPath}</string>
    <key>StandardErrorPath</key><string>${spec.logPath}</string>
</dict>
</plist>
`;

const registerMac = async (spec: AutostartSpec, agent: LaunchAgentSpec, launcher: CliLauncher): Promise<boolean> => {
    const plist = macPlistPath(agent);
    await mkdir(dirname(plist), { recursive: true });
    await writeFile(plist, macLaunchAgentXml(spec, agent, launcher), { mode: 0o644 });
    const uid = process.getuid?.() ?? 0;
    // Bootout any prior instance, then bootstrap (modern launchctl); falls back to legacy `load -w` on older macOS.
    spawnSync("launchctl", ["bootout", `gui/${uid}/${agent.label}`], { stdio: "ignore" });
    if (spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "ignore" }).status === 0) {
        return true;
    }
    register("launchctl", ["load", "-w", plist]);
    return true;
};

// Exactly one of a systemd user unit or an XDG entry is written, never both, or a desktop machine starts the agent
// twice.
const registerLinux = async (spec: AutostartSpec, launcher: CliLauncher, log: Log): Promise<boolean> => {
    if (systemdUserAvailable()) {
        await rm(linuxDesktopPath(spec), { force: true });
        return await registerSystemdUser(spec, launcher, log);
    }
    const file = linuxDesktopPath(spec);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, linuxDesktopEntry(spec, launcher), { mode: 0o644 });
    if (process.env["XDG_CURRENT_DESKTOP"] === undefined) {
        log(
            `note: this machine has neither a systemd user manager nor a desktop session, so nothing will start ${spec.id} at boot. It runs until this machine restarts.`,
        );
    }
    return false;
};

// Registers the agent to start at login. Returns true only when the OS mechanism also launched it for the current
// session (macOS bootstrap, systemd enable --now), so the caller can skip its own spawn.
export const registerAutostart = async (spec: AutostartSpec, launcher: CliLauncher, log: Log): Promise<boolean> => {
    try {
        if (process.platform === "darwin") {
            // No LaunchAgent spec: says so instead of silently writing an XDG entry macOS never reads.
            if (spec.launchAgent === undefined) {
                log(`note: ${spec.id} has no macOS login autostart yet; it runs until this machine restarts.`);
                return false;
            }
            return await registerMac(spec, spec.launchAgent, launcher);
        }
        if (process.platform === "win32") {
            // Registering the flashing shape and saying so beats refusing to register or registering silently: the stub
            // just isn't installed beside a dev checkout.
            const stub = windowsLaunchStub(launcher);
            if (stub === undefined) {
                log(
                    `note: ${WINDOWS_LAUNCH_STUB} isn't installed beside this agent, so ${spec.id} will start at login through a console window that flashes on the desktop. Re-run the install command from the capability card to get it.`,
                );
            }
            register(regExe(), windowsRunAddArgs(spec, launcher, stub));
            return false;
        }
        if (process.platform === "linux") {
            return await registerLinux(spec, launcher, log);
        }
        log(`note: ${spec.id} has no login autostart on ${process.platform}; it runs until this machine restarts.`);
    } catch (error) {
        log(spec.failureNote(reason(error)));
    }
    return false;
};

// Removes the login-autostart entry (and stops the launchd-run instance on macOS). Idempotent and best-effort.
export const unregisterAutostart = async (spec: AutostartSpec, log: Log): Promise<void> => {
    try {
        if (process.platform === "darwin") {
            if (spec.launchAgent === undefined) {
                return;
            }
            const plist = macPlistPath(spec.launchAgent);
            const uid = process.getuid?.() ?? 0;
            spawnSync("launchctl", ["bootout", `gui/${uid}/${spec.launchAgent.label}`], { stdio: "ignore" });
            spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
            await rm(plist, { force: true });
            return;
        }
        if (process.platform === "win32") {
            clearWindowsRunValue(spec.windowsRunValue);
            return;
        }
        // Both Linux mechanisms are cleared unconditionally: leaving the unregistered one behind would resurrect the
        // agent at the next boot. `disable --now` also stops it.
        spawnSync("systemctl", ["--user", "disable", "--now", systemdUnitName(spec)], { stdio: "ignore" });
        await rm(systemdUnitPath(spec), { force: true });
        spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
        await rm(linuxDesktopPath(spec), { force: true });
    } catch (error) {
        log(`note: couldn't remove the login-autostart entry for ${spec.id} (${reason(error)}).`);
    }
};
