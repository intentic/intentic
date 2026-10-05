import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
export const windowsTaskExportArgs = (spec: AutostartSpec): string[] => ["/query", "/tn", spec.windowsRunValue, "/xml"];
export const windowsTaskRunArgs = (spec: AutostartSpec): string[] => ["/run", "/tn", spec.windowsRunValue];

const quietly = (command: string, args: readonly string[]): boolean =>
    spawnSync(command, args, { stdio: "ignore", windowsHide: true }).status === 0;

const windowsTaskExists = (spec: AutostartSpec): boolean => quietly(schtasksExe(), windowsTaskQueryArgs(spec));
const windowsRunValueExists = (spec: AutostartSpec): boolean => quietly(regExe(), ["query", WINDOWS_RUN_KEY, "/v", spec.windowsRunValue]);

/* WHAT A LOGON TASK HOLDS, against what this build writes (2026-10-05). The repair used to ask only whether the task
   EXISTS, and only at the agent's start: a task written by an older build (another restart policy, no `--wait`, so no
   supervision at all) or pointing at a moved install stayed that way for good. Now the task's action and the settings
   that make it a supervisor are compared, at start and in the agent's periodic upkeep, and a task that differs is
   written again. Unlike a systemd unit or a LaunchAgent, a task that launches another command is rewritten too: it is
   filed under this agent's own name, per user, so it can only be an older install of this agent's. */

// XML text as Task Scheduler escapes it, back to the characters. Pure.
const xmlUnescape = (value: string): string =>
    value.replaceAll("&quot;", '"').replaceAll("&apos;", "'").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

// The text of the first `<tag>` element (attributes allowed) in `xml`, or undefined. Pure.
const elementText = (xml: string, tag: string): string | undefined => {
    const found = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml)?.[1];
    return found === undefined ? undefined : xmlUnescape(found.trim());
};

// Settings Windows leaves out of an export when they hold their default, so absent reads as that default.
const SETTING_DEFAULTS: Readonly<Record<string, string>> = {
    MultipleInstancesPolicy: "IgnoreNew",
    DisallowStartIfOnBatteries: "true",
    StopIfGoingOnBatteries: "true",
    StartWhenAvailable: "false",
    ExecutionTimeLimit: "PT72H",
    Enabled: "true",
};

// The facts of a task that decide what it starts and whether it supervises it, each by name. Pure, so the comparison is
// asserted on the XML this build writes and on what Windows exports.
export const windowsTaskFacts = (xml: string): Readonly<Record<string, string>> => {
    const settings = elementText(xml, "Settings") ?? "";
    // Nested blocks hold elements of the same names (an idle `Enabled`?), so scalars are read with them taken out.
    const scalars = settings.replaceAll(/<(IdleSettings|RestartOnFailure|NetworkSettings|MaintenanceSettings)\b[\s\S]*?<\/\1>/g, "");
    const restart = elementText(settings, "RestartOnFailure");
    const repeat = elementText(elementText(xml, "TimeTrigger") ?? "", "Repetition");
    return {
        command: elementText(xml, "Command") ?? "",
        arguments: elementText(xml, "Arguments") ?? "",
        logon: String(/<LogonTrigger[\s>]/.test(xml)),
        repeat: repeat === undefined ? "" : (elementText(repeat, "Interval") ?? ""),
        restart: restart === undefined ? "" : `${elementText(restart, "Interval") ?? ""}x${elementText(restart, "Count") ?? ""}`,
        ...Object.fromEntries(
            Object.entries(SETTING_DEFAULTS).map(([name, fallback]) => [name, (elementText(scalars, name) ?? fallback).toLowerCase()] as const),
        ),
    };
};

// The facts on which a task Windows holds differs from the one this build writes; empty when it is current. Pure.
export const windowsTaskDrift = (held: string, wanted: string): string[] => {
    const have = windowsTaskFacts(held);
    const want = windowsTaskFacts(wanted);
    return Object.keys(want).filter((name) => have[name] !== want[name]);
};

// Bytes a Windows tool printed, as text: UTF-16LE when it says so (a BOM) or looks it (every other byte NUL in an ASCII
// prefix), else UTF-8. Pure.
export const decodeToolOutput = (bytes: Buffer): string => {
    const utf16 = (bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0);
    return (utf16 ? bytes.toString("utf16le") : bytes.toString("utf8")).replace(/^\uFEFF/, "");
};

// The task as Windows holds it, or undefined when it cannot be read. PowerShell's export first, asked for UTF-8 so a
// path with a non-ASCII user name reads back as written; schtasks' own export where PowerShell is not there.
const readWindowsTaskXml = (spec: AutostartSpec): string | undefined => {
    const powershell = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; Export-ScheduledTask -TaskName '${spec.windowsRunValue.replaceAll("'", "''")}' -TaskPath '\\'`;
    const tries: readonly (readonly [string, readonly string[]])[] = [
        [powershell, ["-NoProfile", "-NonInteractive", "-Command", script]],
        [schtasksExe(), windowsTaskExportArgs(spec)],
    ];
    for (const [command, args] of tries) {
        const result = spawnSync(command, args, { windowsHide: true, timeout: 30_000 });
        const text = result.status === 0 && result.stdout.length > 0 ? decodeToolOutput(result.stdout) : "";
        if (text.includes("<Task")) {
            return text;
        }
    }
    return undefined;
};

// What a login entry is now, against what this build would write there.
// - current: exactly what this build writes (or, for a task, the same action and settings);
// - missing: nothing there;
// - stale: this agent's command with an older build's settings, or for a task any difference at all;
// - foreign: a file-based entry launching another command, which a repair leaves to its install;
// - unknown: there, but it could not be read, which a repair leaves as it is.
export type EntryState = "current" | "missing" | "stale" | "foreign" | "unknown";

export interface EntryInspection {
    readonly kind: AutostartKind;
    readonly state: EntryState;
    // What differs, for a stale task: the facts named by windowsTaskFacts.
    readonly drift?: readonly string[];
}

const inspectWindowsTask = (spec: AutostartSpec, launcher: CliLauncher, stub: string): EntryInspection => {
    if (!windowsTaskExists(spec)) {
        // A machine that could not register a task before starts the agent from the Run value; the start's own repair
        // tries the task again.
        return { kind: windowsRunValueExists(spec) ? "run-key" : "task", state: windowsRunValueExists(spec) ? "current" : "missing" };
    }
    const held = readWindowsTaskXml(spec);
    if (held === undefined) {
        return { kind: "task", state: "unknown" };
    }
    const drift = windowsTaskDrift(held, windowsTaskXml(spec, launcher, stub, windowsAccount()));
    return drift.length === 0 ? { kind: "task", state: "current" } : { kind: "task", state: "stale", drift };
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

// A systemd unit argument: double quotes with C escapes, the quoting systemd's own command-line parser reads.
const systemdQuoted = (value: string): string => `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

// The PATH every supervised Linux start gives the agent, which a user manager or a bare `sh -c` would not.
export const supervisedPath = (home: string = homedir()): string => `${join(home, ".local", "bin")}:/usr/local/bin:/usr/bin:/bin`;

// The one log roll every Linux supervisor runs before it opens the log: `$1` the log, `$2` the size that triggers it.
export const ROTATE_LOG_SH = `[ -f "$1" ] && [ "$(wc -c < "$1")" -ge "$2" ] && mv -f "$1" "$1.1"`;

// Restart=on-failure keeps a deliberate stop stopped, but needs the agent to exit non-zero on a signal;
// RestartForceExitStatus forces a restart anyway for SIGHUP/INT/TERM/PIPE, which systemd otherwise treats as clean. The
// agent's hang watchdog ends it with SIGKILL, an unclean signal on-failure always restarts.
// KillMode=process stops the agent's own process and nothing else: systemd's default ends the unit's whole cgroup, which
// took down what the agent had started to outlive it (an `ic` mid-swap, whose container was left parked with nothing
// started in its place, and Mutagen's daemon). What must not outlive it the agent ends itself as it stops.
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
KillMode=process
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
// 128+SIGNAL otherwise). An exit by signal (the hang watchdog's SIGKILL) is not a successful one, so it is restarted too. Without it a crashed agent stayed dead until the next login, with nothing watching.
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
    // Writes the login entry, or with `repair` only puts back one that is missing or rewrites one whose content is not
    // what this build writes (inspect's `stale`); never starts anything.
    readonly register: (options?: { readonly repair?: boolean }) => Promise<AutostartKind>;
    // The entry as it stands against what this build writes, changing nothing.
    readonly inspect: () => Promise<EntryInspection>;
    // Whether any mechanism holds an entry under this spec's names, whatever it launches: what retiring one asks.
    readonly present: () => Promise<boolean>;
    // Starts the agent through its entry; false where the entry cannot start one and the caller has to spawn it.
    readonly start: () => Promise<boolean>;
    // Clears every mechanism's entry, since which one is in force depends on what the last register found.
    readonly unregister: () => Promise<void>;
}

// Whether a repair leaves the task as it is: when it is there and current, or could not be read (nothing is rewritten
// on a guess). A stale one is said with what differs, and written again; a missing one (a Run value standing in for it
// included) is registered again, as every start has always tried.
const keepsTask = (inspection: EntryInspection, spec: AutostartSpec, log: Log): boolean => {
    if (inspection.kind === "task" && inspection.state === "stale") {
        log(`the "${spec.windowsRunValue}" logon task differs from what this agent writes (${(inspection.drift ?? []).join(", ")}): writing it again.`);
        return false;
    }
    return inspection.kind === "task" && (inspection.state === "current" || inspection.state === "unknown");
};

// The stub is what makes a logon task silent, so without one the task is not offered: a console window at every
// logon and every watchdog tick is worse than the Run key. A machine that cannot register a task still starts at login.
const windowsAutostart = (spec: AutostartSpec, launcher: CliLauncher, log: Log): Autostart => ({
    inspect: async () => {
        const stub = windowsLaunchStub(launcher);
        if (stub === undefined) {
            return await Promise.resolve({ kind: "run-key" as const, state: windowsRunValueExists(spec) ? ("current" as const) : ("missing" as const) });
        }
        return await Promise.resolve(inspectWindowsTask(spec, launcher, stub));
    },
    present: async () => await Promise.resolve(windowsTaskExists(spec) || windowsRunValueExists(spec)),
    register: async ({ repair = false } = {}) => {
        const stub = windowsLaunchStub(launcher);
        if (stub === undefined) {
            log(
                `note: ${WINDOWS_LAUNCH_STUB} isn't installed beside this agent, so ${spec.id} will start at login through a console window that flashes on the desktop. Re-run the install command from the capability card to get it.`,
            );
        } else if (repair && keepsTask(inspectWindowsTask(spec, launcher, stub), spec, log)) {
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

// What a login entry's file holds now; undefined when it is not there (or cannot be read, which a rewrite then settles).
// allow(silent-catch): an unreadable entry is one to write again, the same as a missing one
const currentEntry = async (path: string): Promise<string | undefined> => await readFile(path, "utf8").catch(() => undefined);

// Whether `repair` may leave a file-based entry as it is: when it holds exactly what this build would write, or when it
// launches something else (another install's entry, which a repair is not the moment to take over). An entry launching
// this same command with an older build's settings (a unit without KillMode=process, say) is rewritten, since its
// supervisor keeps reading the old one. `launch` picks out the part of an entry that names what it starts.
export const entryCurrent = (current: string | undefined, wanted: string, launch: (entry: string) => string | undefined): boolean => {
    const state = fileEntryState(current, wanted, launch);
    return state === "current" || state === "foreign";
};

// The same reading, said as an EntryState. Pure.
export const fileEntryState = (current: string | undefined, wanted: string, launch: (entry: string) => string | undefined): EntryState => {
    if (current === undefined) {
        return "missing";
    }
    if (current === wanted) {
        return "current";
    }
    return launch(current) === launch(wanted) ? "stale" : "foreign";
};

// What each kind of entry starts: the line under its key, or for a plist its argument array.
const launchLine =
    (key: string) =>
    (entry: string): string | undefined =>
        entry.split("\n").find((line) => line.startsWith(key));
const plistArguments = (entry: string): string | undefined => {
    const from = entry.indexOf("<key>ProgramArguments</key>");
    return from < 0 ? undefined : entry.slice(from, entry.indexOf("</array>", from));
};

// Exactly one of a systemd user unit or an XDG entry is written, never both, or a desktop machine starts it twice.
// Lingering keeps the user manager (and the unit) alive without a session, or a headless box never autostarts.
const linuxAutostart = (spec: AutostartSpec, launcher: CliLauncher, log: Log): Autostart => ({
    inspect: async () => {
        if (systemdUserAvailable()) {
            return { kind: "systemd", state: fileEntryState(await currentEntry(systemdUnitPath(spec)), systemdUserUnit(spec, launcher), launchLine("ExecStart=")) };
        }
        return { kind: "xdg", state: fileEntryState(await currentEntry(linuxDesktopPath(spec)), linuxDesktopEntry(spec, launcher), launchLine("Exec=")) };
    },
    present: async () => existsSync(systemdUnitPath(spec)) || existsSync(linuxDesktopPath(spec)),
    register: async ({ repair = false } = {}) => {
        if (systemdUserAvailable()) {
            const unit = systemdUnitPath(spec);
            const wanted = systemdUserUnit(spec, launcher);
            if (repair && entryCurrent(await currentEntry(unit), wanted, launchLine("ExecStart="))) {
                return "systemd";
            }
            await rm(linuxDesktopPath(spec), { force: true });
            await mkdir(dirname(unit), { recursive: true });
            await writeFile(unit, wanted, { mode: 0o644 });
            spawnSync("loginctl", ["enable-linger"], { stdio: "ignore" });
            // daemon-reload so a rewritten unit is picked up, not the version systemd already parsed.
            spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
            register("systemctl", ["--user", "enable", systemdUnitName(spec)]);
            log(`${systemdUnitName(spec)} is registered to run at boot. Follow it with: tail -f ${spec.logPath}`);
            return "systemd";
        }
        const file = linuxDesktopPath(spec);
        const entry = linuxDesktopEntry(spec, launcher);
        if (!(repair && entryCurrent(await currentEntry(file), entry, launchLine("Exec=")))) {
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, entry, { mode: 0o644 });
        }
        if (process.env["XDG_CURRENT_DESKTOP"] === undefined) {
            log(
                `note: this machine has neither a systemd user manager nor a desktop session, so nothing will start ${spec.id} at boot. It runs until this machine restarts.`,
            );
        }
        return "xdg";
    },
    start: async () =>
        systemdUserAvailable() && (await currentEntry(systemdUnitPath(spec))) !== undefined && quietly("systemctl", ["--user", "start", systemdUnitName(spec)]),
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
        inspect: async () => ({ kind: "launchd", state: fileEntryState(await currentEntry(plist), macLaunchAgentXml(spec, agent, launcher), plistArguments) }),
        present: async () => await Promise.resolve(existsSync(plist)),
        register: async ({ repair = false } = {}) => {
            const wanted = macLaunchAgentXml(spec, agent, launcher);
            if (!(repair && entryCurrent(await currentEntry(plist), wanted, plistArguments))) {
                await mkdir(dirname(plist), { recursive: true });
                await writeFile(plist, wanted, { mode: 0o644 });
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
    inspect: async () => await Promise.resolve({ kind: "none" as const, state: "current" as const }),
    present: async () => await Promise.resolve(false),
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
        // allow(silent-catch): an entry that cannot be read is one a repair leaves alone (EntryState's `unknown`)
        inspect: async () => await mechanism.inspect().catch(() => ({ kind: "none" as const, state: "unknown" as const })),
        present: async () => await mechanism.present(),
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
