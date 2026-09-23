import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { LOG_ROTATE_BYTES } from "./detached.js";
import { type CliLauncher, quotedCommandLine, stubCommand, WINDOWS_LAUNCH_STUB, windowsLaunchStub } from "./launcher.js";
import type { Log } from "./home.js";

// Login autostart per OS, every mechanism supervising what it starts and none needing elevation or a password: a
// per-user logon task through the launcher stub on Windows (the Run key as fallback), a systemd user unit on Linux
// (an XDG entry where there is no user manager), a LaunchAgent on macOS.

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
    // Absent: no macOS autostart for this agent, which then says so rather than writing a file nothing reads.
    readonly launchAgent?: LaunchAgentSpec;
    // foreground: args for mechanisms that supervise the agent. detached: Windows fallback, spawns and exits.
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

/* ---- the supervised Windows shape: a per-user logon task ---- */

// A Run value starts the agent once at logon and nothing watches it afterwards, which is the whole of "it stopped
// running and nobody noticed". A per-user logon task is the same launch with a supervisor attached: Task Scheduler
// restarts a failed action, and a repeating trigger re-starts one that exited cleanly or was killed. It needs no
// password and no elevation because the principal is an InteractiveToken for the user registering it — the schtasks
// form that DOES need a password is `/sc ONLOGON /ru`, which is why this goes in as XML.

// How often the watchdog trigger starts the task. `IgnoreNew` makes a start while the agent is up a no-op, so this is
// the interval on noticing a dead agent, not on anything that happens to a healthy one.
const WINDOWS_WATCHDOG_MINUTES = 5;
// How many times Task Scheduler restarts a FAILED action before leaving it to the watchdog above.
const WINDOWS_RESTART_COUNT = 3;

const schtasksExe = (): string => join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "schtasks.exe");

// The account the task logs on for and runs as. A bare username is accepted, but a qualified one is what the Task
// Scheduler UI shows back and what survives a machine rename.
const windowsAccount = (): string => {
    const user = process.env["USERNAME"] ?? "";
    const domain = process.env["USERDOMAIN"] ?? "";
    return domain === "" || user === "" ? user : `${domain}\\${user}`;
};

// Paths and command lines land in XML text nodes, and a Windows path may legally hold `&`.
const xmlText = (value: string): string => value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

// The task, in the element order Windows itself writes when it exports one: Task Scheduler's parser is positional
// within <Settings>, so matching its own output is the only ordering that is not a guess. Schema 1.2, which is also a
// constraint on the CONTENT: `UseUnifiedSchedulingEngine` and `DisallowStartOnRemoteAppSession` are 1.4 nodes and a
// 1.2 task is refused outright for carrying them ("the task XML contains an unexpected node"). Both were the default
// anyway, so this stays at the version every supported Windows parses rather than bumping for two nodes it can lose.
export const windowsTaskXml = (spec: AutostartSpec, launcher: CliLauncher, stub: string, account: string): string => {
    // `--wait` is what makes the task a supervisor rather than a launcher: a task counts as RUNNING only while its
    // action process does, which is what `IgnoreNew` swallows repetitions against and what a restart is measured from.
    const [program, ...args] = [stub, "--log", spec.logPath, "--wait", "--", ...launcher, ...spec.foregroundArgs];
    return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xmlText(spec.desktopComment)}</Description>
    <URI>\\${xmlText(spec.windowsRunValue)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xmlText(account)}</UserId>
    </LogonTrigger>
    <TimeTrigger>
      <Repetition>
        <Interval>PT${WINDOWS_WATCHDOG_MINUTES}M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <StartBoundary>2020-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xmlText(account)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>${WINDOWS_RESTART_COUNT}</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlText(program ?? "")}</Command>
      <Arguments>${xmlText(quotedCommandLine(args))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
};

export const windowsTaskCreateArgs = (spec: AutostartSpec, xmlPath: string): string[] => [
    "/create",
    "/tn",
    spec.windowsRunValue,
    "/xml",
    xmlPath,
    "/f",
];

export const windowsTaskDeleteArgs = (spec: AutostartSpec): string[] => ["/delete", "/tn", spec.windowsRunValue, "/f"];

// schtasks reads the file, so it has to be a file. UTF-16LE with a BOM, matching the declaration above: schtasks
// rejects a UTF-8 body under a UTF-16 declaration with an error that blames the task's values rather than its bytes.
const registerWindowsTask = async (spec: AutostartSpec, launcher: CliLauncher, stub: string, log: Log): Promise<void> => {
    const account = windowsAccount();
    if (account === "") {
        throw new Error("this session names no user (USERNAME is unset), so a per-user logon task has nobody to run as");
    }
    const xmlPath = join(tmpdir(), `${spec.id}-${process.pid}.xml`);
    try {
        await writeFile(xmlPath, Buffer.from(`\uFEFF${windowsTaskXml(spec, launcher, stub, account)}`, "utf16le"));
        register(schtasksExe(), windowsTaskCreateArgs(spec, xmlPath));
    } finally {
        await rm(xmlPath, { force: true });
    }
    // Both would start an agent at logon, and the second would find the pidfile held and leave. Tidier to have one.
    clearWindowsRunValue(spec.windowsRunValue);
    log(
        `registered the "${spec.windowsRunValue}" logon task: it starts at sign-in, restarts on failure, and is re-checked every ${WINDOWS_WATCHDOG_MINUTES} minutes.`,
    );
};

// Throws with what reg.exe actually said.
export const setWindowsRunValue = (name: string, commandLine: string): void => register(regExe(), windowsRunValueAddArgs(name, commandLine));

// `reg delete` exits non-zero when the value is already gone; ignored here for a repeat uninstall.
export const clearWindowsRunValue = (name: string): void => {
    spawnSync(regExe(), windowsRunValueDeleteArgs(name), { stdio: "ignore", windowsHide: true });
};

export const windowsTaskQueryArgs = (spec: AutostartSpec): string[] => ["/query", "/tn", spec.windowsRunValue];
export const windowsTaskRunArgs = (spec: AutostartSpec): string[] => ["/run", "/tn", spec.windowsRunValue];

const quietly = (command: string, args: readonly string[]): boolean =>
    spawnSync(command, args, { stdio: "ignore", windowsHide: true }).status === 0;

const windowsTaskExists = (spec: AutostartSpec): boolean => quietly(schtasksExe(), windowsTaskQueryArgs(spec));
const windowsRunValueExists = (spec: AutostartSpec): boolean => quietly(regExe(), ["query", WINDOWS_RUN_KEY, "/v", spec.windowsRunValue]);

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

// A systemd unit argument: double quotes with C escapes, the quoting systemd's own command-line parser reads.
const systemdQuoted = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

// The PATH every supervised Linux start gives the agent, which a user manager or a bare `sh -c` would not.
export const supervisedPath = (home: string = homedir()): string => `${join(home, ".local", "bin")}:/usr/local/bin:/usr/bin:/bin`;

// The one log roll every Linux supervisor runs before it opens the log: `$1` the log, `$2` the size that triggers it.
export const ROTATE_LOG_SH = `[ -f "$1" ] && [ "$(wc -c < "$1")" -ge "$2" ] && mv -f "$1" "$1.1"`;

// Restart=on-failure keeps a deliberate stop stopped, but needs the agent to exit non-zero on a signal;
// RestartForceExitStatus forces a restart anyway for SIGHUP/INT/TERM/PIPE, which systemd otherwise treats as clean.
export const systemdUserUnit = (spec: AutostartSpec, launcher: CliLauncher): string => {
    return `[Unit]
Description=${spec.desktopName}: ${spec.desktopComment}
After=network-online.target

[Service]
Type=simple
ExecStartPre=-/bin/sh -c ${systemdQuoted(ROTATE_LOG_SH)} rotate ${systemdQuoted(spec.logPath)} ${LOG_ROTATE_BYTES}
ExecStart=${quotedCommandLine([...launcher, ...spec.foregroundArgs])}
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}
Restart=on-failure
RestartSec=5
RestartForceExitStatus=SIGHUP SIGINT SIGTERM SIGPIPE
StartLimitIntervalSec=0
Environment=PATH=${supervisedPath()}

[Install]
WantedBy=default.target
`;
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

// RunAtLoad starts it at login; KeepAlive restarts it afterwards, but only when it exits non-zero — the same bargain
// systemd's `Restart=on-failure` makes, and it lines up with this agent's own exits (0 for every deliberate stop,
// 128+SIGNAL otherwise). Without it a crashed agent stayed dead until the next login, with nothing watching.
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
    <key>KeepAlive</key>
    <dict><key>SuccessfulExit</key><false/></dict>
    <key>StandardOutPath</key><string>${spec.logPath}</string>
    <key>StandardErrorPath</key><string>${spec.logPath}</string>
</dict>
</plist>
`;

// Who restarts the agent once registered: the word the running process stamps beside its pid, so readers know.
export type AutostartKind = "task" | "run-key" | "systemd" | "launchd" | "xdg" | "none";

export interface Autostart {
    // Writes the login entry, or with `repair` only puts back one that is missing; never starts anything.
    readonly register: (options?: { readonly repair?: boolean }) => Promise<AutostartKind>;
    // Starts the agent through its entry; false where the entry cannot start one and the caller has to spawn it.
    readonly start: () => Promise<boolean>;
    // Clears every mechanism's entry, since which one is in force depends on what the last register found.
    readonly unregister: () => Promise<void>;
}

// The stub is what makes a logon task silent, so without one the task is not offered: a console window at every
// logon and every watchdog tick is worse than the Run key. A machine that cannot register a task still starts at login.
const windowsAutostart = (spec: AutostartSpec, launcher: CliLauncher, log: Log): Autostart => ({
    register: async ({ repair = false } = {}) => {
        const stub = windowsLaunchStub(launcher);
        if (stub === undefined) {
            log(
                `note: ${WINDOWS_LAUNCH_STUB} isn't installed beside this agent, so ${spec.id} will start at login through a console window that flashes on the desktop. Re-run the install command from the capability card to get it.`,
            );
        } else if (repair && windowsTaskExists(spec)) {
            return "task";
        } else {
            try {
                await registerWindowsTask(spec, launcher, stub, log);
                return "task";
            } catch (error) {
                log(
                    `note: couldn't register a logon task for ${spec.id} (${reason(error)}); falling back to a login entry that starts it once and is not supervised.`,
                );
            }
        }
        if (repair && windowsRunValueExists(spec)) {
            return "run-key";
        }
        register(regExe(), windowsRunAddArgs(spec, launcher, stub));
        return "run-key";
    },
    // IgnoreNew makes a second /run while one runs a no-op, so the caller may repeat it while it waits.
    start: async () => await Promise.resolve(windowsTaskExists(spec) && quietly(schtasksExe(), windowsTaskRunArgs(spec))),
    unregister: async () => {
        spawnSync(schtasksExe(), windowsTaskDeleteArgs(spec), { stdio: "ignore", windowsHide: true });
        clearWindowsRunValue(spec.windowsRunValue);
        return await Promise.resolve();
    },
});

// Exactly one of a systemd user unit or an XDG entry is written, never both, or a desktop machine starts it twice.
// Lingering keeps the user manager (and the unit) alive without a session, or a headless box never autostarts.
const linuxAutostart = (spec: AutostartSpec, launcher: CliLauncher, log: Log): Autostart => ({
    register: async ({ repair = false } = {}) => {
        if (systemdUserAvailable()) {
            const unit = systemdUnitPath(spec);
            if (repair && existsSync(unit)) {
                return "systemd";
            }
            await rm(linuxDesktopPath(spec), { force: true });
            await mkdir(dirname(unit), { recursive: true });
            await writeFile(unit, systemdUserUnit(spec, launcher), { mode: 0o644 });
            spawnSync("loginctl", ["enable-linger"], { stdio: "ignore" });
            // daemon-reload so a rewritten unit is picked up, not the version systemd already parsed.
            spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
            register("systemctl", ["--user", "enable", systemdUnitName(spec)]);
            log(`${systemdUnitName(spec)} is registered to run at boot. Follow it with: tail -f ${spec.logPath}`);
            return "systemd";
        }
        const file = linuxDesktopPath(spec);
        if (!(repair && existsSync(file))) {
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, linuxDesktopEntry(spec, launcher), { mode: 0o644 });
        }
        if (process.env["XDG_CURRENT_DESKTOP"] === undefined) {
            log(
                `note: this machine has neither a systemd user manager nor a desktop session, so nothing will start ${spec.id} at boot. It runs until this machine restarts.`,
            );
        }
        return "xdg";
    },
    start: async () =>
        await Promise.resolve(systemdUserAvailable() && existsSync(systemdUnitPath(spec)) && quietly("systemctl", ["--user", "start", systemdUnitName(spec)])),
    // Both mechanisms, unconditionally: the one left behind would resurrect the agent at the next boot. `--now` stops it.
    unregister: async () => {
        spawnSync("systemctl", ["--user", "disable", "--now", systemdUnitName(spec)], { stdio: "ignore" });
        await rm(systemdUnitPath(spec), { force: true });
        spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
        await rm(linuxDesktopPath(spec), { force: true });
    },
});

// launchd reads the LaunchAgents directory at login, so the file alone is the whole of "resume at boot".
const macAutostart = (spec: AutostartSpec, agent: LaunchAgentSpec, launcher: CliLauncher): Autostart => {
    const plist = macPlistPath(agent);
    const domain = `gui/${process.getuid?.() ?? 0}`;
    return {
        register: async ({ repair = false } = {}) => {
            if (!(repair && existsSync(plist))) {
                await mkdir(dirname(plist), { recursive: true });
                await writeFile(plist, macLaunchAgentXml(spec, agent, launcher), { mode: 0o644 });
            }
            return "launchd";
        },
        // A job already loaded refuses a second bootstrap; kickstart is what starts a loaded job that is not running.
        start: async () =>
            await Promise.resolve(quietly("launchctl", ["bootstrap", domain, plist]) || quietly("launchctl", ["kickstart", `${domain}/${agent.label}`])),
        unregister: async () => {
            spawnSync("launchctl", ["bootout", `${domain}/${agent.label}`], { stdio: "ignore" });
            spawnSync("launchctl", ["unload", plist], { stdio: "ignore" });
            await rm(plist, { force: true });
        },
    };
};

// Where there is nothing to register with, or no LaunchAgent spec on macOS, it says so instead of writing a file
// nothing reads.
const noAutostart = (spec: AutostartSpec, log: Log): Autostart => ({
    register: async () => {
        log(`note: ${spec.id} has no login autostart on ${process.platform}; it runs until this machine restarts.`);
        return await Promise.resolve("none");
    },
    start: async () => await Promise.resolve(false),
    unregister: async () => await Promise.resolve(),
});

const mechanismFor = (spec: AutostartSpec, launcher: CliLauncher, log: Log): Autostart => {
    if (process.platform === "win32") {
        return windowsAutostart(spec, launcher, log);
    }
    if (process.platform === "linux") {
        return linuxAutostart(spec, launcher, log);
    }
    if (process.platform === "darwin" && spec.launchAgent !== undefined) {
        return macAutostart(spec, spec.launchAgent, launcher);
    }
    return noAutostart(spec, log);
};

// Best-effort throughout: a failed registration costs resume-after-reboot, never the session already running.
export const autostart = (spec: AutostartSpec, launcher: CliLauncher, log: Log): Autostart => {
    const mechanism = mechanismFor(spec, launcher, log);
    return {
        register: async (options) => {
            try {
                return await mechanism.register(options);
            } catch (error) {
                log(spec.failureNote(reason(error)));
                return "none";
            }
        },
        start: async () => await mechanism.start().catch(() => false),
        unregister: async () => {
            try {
                await mechanism.unregister();
            } catch (error) {
                log(`note: couldn't remove the login-autostart entry for ${spec.id} (${reason(error)}).`);
            }
        },
    };
};
