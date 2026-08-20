import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type CliLauncher, quotedCommandLine } from "./launcher.js";
import type { Log } from "./home.js";

/* LOGIN AUTOSTART, so the machine is doing its job again after a reboot without anyone remembering to start
 * anything. Best-effort throughout: whoever calls this has already started the current session itself, so a
 * failed registration costs reboot-resume and nothing else, and it says so rather than failing the install.
 *
 * The mechanisms are the user's OWN, per platform, and all three are chosen for the same reason: no elevation,
 * no password prompt, no machine-wide change.
 *
 *   Windows, the per-user Run key. Task Scheduler was the wrong tool twice over and failed on every
 *             non-elevated shell: `/SC ONLOGON` registers a trigger for "whenever a user (ANY user) logs on",
 *             which is a machine-wide change, and schtasks "always prompts for a password ... even when you
 *             schedule a task on the local computer using the current user account", which against a spawn's
 *             empty stdin can only fail. Mutagen writes to this exact key, and its registration kept succeeding
 *             in the same runs where the schtasks one died.
 *   macOS  , a launchd LaunchAgent. Optional: an agent that has not been exercised there declares no
 *             `launchAgent` and gets a note instead of a file, rather than an XDG entry macOS never reads.
 *   Linux  , a systemd USER UNIT where there is a user manager to run it, and an XDG autostart entry only where
 *             there isn't. The XDG entry alone was wrong for the machines that need autostart MOST: it is started
 *             by the desktop session at graphical login, so on a headless box, a server, a container, every WSL
 *             distro, it can never fire at all. Registration used to write it anyway and print a note naming
 *             `systemd-run --user` as the answer, which put the one machine class that cannot autostart in charge
 *             of fixing it by hand, with a command that is TRANSIENT: it runs the agent in the current session and
 *             is gone at the next boot, which is the whole thing autostart is for. A user unit is the same
 *             no-elevation, no-machine-wide-change bargain as the other two, and it is what systemd's own
 *             `enable --now` was built for.
 *
 * Everything below is a pure function of the spec plus the launcher, except the ones that spawn an OS tool. */

export interface LaunchAgentSpec {
    // Reverse-DNS, launchd's convention, the id `launchctl bootout` and `bootstrap` address it by.
    readonly label: string;
}

export interface AutostartSpec {
    /* The agent's slug: the XDG autostart file's base name, and the systemd unit named in the headless note.
     * Not the launchd label, that one is reverse-DNS and does not derive from this. */
    readonly id: string;
    /* WHERE THE LOOP'S OUTPUT GOES, under every mechanism that supervises it. Not a macOS detail, though it lived
     * inside the LaunchAgent spec as one: systemd supervises the foreground loop exactly as launchd does, and a
     * unit that does not say this sends the output to the journal instead, while the agent's own notes, its
     * status command and its docs all name this file. The result was a log that stopped growing on precisely the
     * machines whose autostart worked, with the live failure sitting in a journal nobody had been told about. One
     * sink, named by the agent, honoured by every mechanism that has somewhere to put it. */
    readonly logPath: string;
    // The value name under HKCU\…\Run. What `unregister` deletes, so it must match what `register` added or an
    // uninstall leaves the agent resurrecting at every login.
    readonly windowsRunValue: string;
    // What the desktop session shows for the entry.
    readonly desktopName: string;
    readonly desktopComment: string;
    // Absent = this agent has no macOS autostart. See registerAutostart.
    readonly launchAgent?: LaunchAgentSpec;
    /* The CLI arguments each kind of mechanism runs, after the launcher.
     *
     * `detached` is for Windows, whose Run entry Explorer starts in the INTERACTIVE session, where a console
     * program owns a console window for as long as it lives. Registering the foreground loop there would park a
     * black window on the desktop from login until shutdown, so the Run value runs the short command that
     * spawns the hidden loop and exits.
     *
     * `foreground` is for the mechanisms that SUPERVISE what they start (launchd, the desktop session): they
     * want the loop itself, in the foreground, so they can see it stop. */
    readonly detachedArgs: readonly string[];
    readonly foregroundArgs: readonly string[];
    // What the user is told when registration fails. Agent-specific, because what they lose and how to retry is.
    readonly failureNote: (reason: string) => string;
}

const WINDOWS_RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const linuxDesktopPath = (spec: AutostartSpec): string => join(homedir(), ".config", "autostart", `${spec.id}.desktop`);
const macPlistPath = (agent: LaunchAgentSpec): string => join(homedir(), "Library", "LaunchAgents", `${agent.label}.plist`);

const systemdUnitName = (spec: AutostartSpec): string => `${spec.id}.service`;
const systemdUnitPath = (spec: AutostartSpec): string => join(homedir(), ".config", "systemd", "user", systemdUnitName(spec));

// reg.exe by absolute path: PATH is not ours to trust for a program that edits the registry, and a spawn that
// can't find its command fails indistinguishably from one that ran and refused.
const regExe = (): string => join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "reg.exe");

const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error));

// Run a registration tool and fail with what it ACTUALLY said. These calls were once `stdio: "ignore"` plus an
// exit-code check, which reduced every failure to a guess we wrote ourselves: the note read "schtasks /Create
// failed" for three sandboxes running while the tool had a one-line reason to give. Which stream carries the
// reason is the tool's business (schtasks answers on stdout, launchctl on stderr), so both are kept, and a spawn
// that never ran hands back its own error rather than a status of null.
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

// `reg add … /f` overwrites whatever is there, so a re-run after the agent moves re-points the entry.
export const windowsRunAddArgs = (spec: AutostartSpec, launcher: CliLauncher): string[] => [
    "add",
    WINDOWS_RUN_KEY,
    "/v",
    spec.windowsRunValue,
    "/t",
    "REG_SZ",
    "/d",
    quotedCommandLine([...launcher, ...spec.detachedArgs]),
    "/f",
];

export const windowsRunDeleteArgs = (spec: AutostartSpec): string[] => ["delete", WINDOWS_RUN_KEY, "/v", spec.windowsRunValue, "/f"];

/* The states `systemctl --user is-system-running` reports when there IS a user manager to talk to. "degraded"
 * counts, it means some unrelated unit of the user's failed, not that ours can't run, and so does a startup
 * still in progress. Anything else (no systemctl at all, no D-Bus session, `offline`) means there is nothing to
 * register with, and the XDG entry is the only mechanism left.
 *
 * Asked rather than assumed from `process.platform`: musl containers, WSL distros with `systemd=false` and
 * non-systemd distributions all run Linux and have no user manager. */
const SYSTEMD_LIVE_STATES = new Set(["running", "degraded", "starting", "maintenance", "stopping", "initializing"]);

const systemdUserAvailable = (): boolean => {
    const result = spawnSync("systemctl", ["--user", "is-system-running"], { encoding: "utf8" });
    if (result.error !== undefined) {
        return false; // no systemctl on PATH
    }
    // Non-zero exit is normal for "degraded", so the STATE it printed decides, not the status.
    return SYSTEMD_LIVE_STATES.has(result.stdout.trim());
};

/* The user unit. ExecStart takes the FOREGROUND args because systemd supervises what it starts, exactly like
 * launchd and the desktop session.
 *
 * `Restart=on-failure` and not `always`: a deliberate `systemctl --user stop` must stay stopped, which is the same
 * call the macOS LaunchAgent makes by omitting KeepAlive. And PATH is set explicitly because a user unit does NOT
 * inherit a login shell's environment, it starts from a minimal PATH, while these agents shell out to `git` and
 * `ssh` on every tick (the git bridge) and to Mutagen's own ssh transport.
 *
 * THE OUTPUT GOES WHERE THE AGENT SAYS IT GOES. A unit with no StandardOutput sends the loop's stdout to the
 * journal, while the agent's own commands, its notes and its docs all name its log file, so on exactly the
 * machines that autostart properly (a systemd box, which is most Linux desktops and every WSL distro with systemd
 * on), the log a user is told to read froze at whatever the last hand-started run wrote, and the live failure was
 * in a journal nobody was pointed at. `append:` rather than `file:` for the same reason the file is append-only
 * everywhere else: a restart must not truncate the pass that explains why it restarted. This is the ONE detail
 * that decides whether a stalled agent can be diagnosed at all, so it follows the same log path launchd is
 * already given, and an agent that declares none keeps the journal. */
export const systemdUserUnit = (spec: AutostartSpec, launcher: CliLauncher): string => {
    return `[Unit]
Description=${spec.desktopName} — ${spec.desktopComment}
After=network-online.target

[Service]
Type=simple
ExecStart=${quotedCommandLine([...launcher, ...spec.foregroundArgs])}
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}
Restart=on-failure
RestartSec=5
Environment=PATH=${join(homedir(), ".local", "bin")}:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
`;
};

/* Register (and start) the unit. `enable --now` is one call for both halves, resume at boot, plus running right
 * now, which is why this branch can report that the current session is covered.
 *
 * Lingering is the piece a hand-rolled `systemd-run --user` misses. Without it a user manager exists only while
 * the user has a session, so on a headless box the unit stops the moment the last shell exits and never returns
 * at boot: `enable` would have been a promise the machine could not keep. Best-effort, polkit grants
 * set-self-linger by default, and where it doesn't the unit still covers every session the user opens. */
const registerSystemdUser = async (spec: AutostartSpec, launcher: CliLauncher, log: Log): Promise<boolean> => {
    const unit = systemdUnitPath(spec);
    await mkdir(dirname(unit), { recursive: true });
    await writeFile(unit, systemdUserUnit(spec, launcher), { mode: 0o644 });
    spawnSync("loginctl", ["enable-linger"], { stdio: "ignore" });
    // daemon-reload so a rewritten unit is the one that gets started, not the copy systemd already parsed.
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    register("systemctl", ["--user", "enable", "--now", systemdUnitName(spec)]);
    // Named by its LOG rather than by the journal: the unit writes to the agent's own file (see systemdUserUnit),
    // so that is where a reader finds this run and every earlier one, whichever way the agent was started.
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

// RunAtLoad starts it at login (and at bootstrap time). No KeepAlive, a deliberate stop should stay stopped,
// and the current session is separately covered by whoever called register.
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
    // Reload cleanly: bootout any prior instance, then bootstrap (modern launchctl). Bootstrap loads + starts it
    // now (RunAtLoad), so the caller skips its own spawn. Fall back to legacy `load -w` on older macOS, which
    // RunAtLoad starts too, and which reports why if IT fails, since nothing else is left to try.
    spawnSync("launchctl", ["bootout", `gui/${uid}/${agent.label}`], { stdio: "ignore" });
    if (spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "ignore" }).status === 0) {
        return true;
    }
    register("launchctl", ["load", "-w", plist]);
    return true;
};

/* A user unit where one can run, an XDG entry only where one can't. Exactly ONE of the two is ever written: both
 * would start the agent twice on a desktop machine, once by systemd at boot, once by the session at login, and
 * two copies of a resident agent is precisely what the pidfile dance downstream exists to avoid. */
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

/* Register the agent to start at login.
 *
 * Returns true only when the OS mechanism ALSO launched it for the CURRENT session, so the caller can skip its own
 * spawn and avoid running two: macOS `bootstrap` does, and so does systemd `enable --now`. Windows' Run key and an
 * XDG entry fire at the next login only, so they answer false and the caller covers this session.
 */
export const registerAutostart = async (spec: AutostartSpec, launcher: CliLauncher, log: Log): Promise<boolean> => {
    try {
        if (process.platform === "darwin") {
            // An agent with no LaunchAgent spec says so, rather than writing an XDG entry macOS never reads,
            // which is what a shared linux/else branch would silently do.
            if (spec.launchAgent === undefined) {
                log(`note: ${spec.id} has no macOS login autostart yet; it runs until this machine restarts.`);
                return false;
            }
            return await registerMac(spec, spec.launchAgent, launcher);
        }
        if (process.platform === "win32") {
            register(regExe(), windowsRunAddArgs(spec, launcher));
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

// Remove the login-autostart entry (and, on macOS, stop the launchd-run instance). Idempotent + best-effort.
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
            // `reg delete` exits non-zero when the value is already gone, which is the normal case for a second
            // uninstall, ignoring that is this branch's `rm --force`.
            spawnSync(regExe(), windowsRunDeleteArgs(spec), { stdio: "ignore" });
            return;
        }
        /* Both Linux mechanisms, unconditionally. Which one is registered depends on what the machine could run at
         * the time, and an uninstall must not leave the other behind, a `disable` skipped because systemd looks
         * unavailable right now would resurrect the agent at the next boot, which is the one thing uninstall has to
         * prevent. `disable --now` stops it as well, so nothing is left resident. */
        spawnSync("systemctl", ["--user", "disable", "--now", systemdUnitName(spec)], { stdio: "ignore" });
        await rm(systemdUnitPath(spec), { force: true });
        spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
        await rm(linuxDesktopPath(spec), { force: true });
    } catch (error) {
        log(`note: couldn't remove the login-autostart entry for ${spec.id} (${reason(error)}).`);
    }
};
