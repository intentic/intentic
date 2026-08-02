import { spawnSync } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type CliLauncher, quotedCommandLine } from "./launcher.js";
import type { Log } from "./home.js";

/* LOGIN AUTOSTART, so the machine is doing its job again after a reboot without anyone remembering to start
 * anything. Best-effort throughout: whoever calls this has already started the current session itself, so a
 * failed registration costs reboot-resume and nothing else — and it says so rather than failing the install.
 *
 * The mechanisms are the user's OWN, per platform, and all three are chosen for the same reason: no elevation,
 * no password prompt, no machine-wide change.
 *
 *   Windows — the per-user Run key. Task Scheduler was the wrong tool twice over and failed on every
 *             non-elevated shell: `/SC ONLOGON` registers a trigger for "whenever a user (ANY user) logs on",
 *             which is a machine-wide change, and schtasks "always prompts for a password ... even when you
 *             schedule a task on the local computer using the current user account", which against a spawn's
 *             empty stdin can only fail. Mutagen writes to this exact key, and its registration kept succeeding
 *             in the same runs where the schtasks one died.
 *   macOS   — a launchd LaunchAgent. Optional: an agent that has not been exercised there declares no
 *             `launchAgent` and gets a note instead of a file, rather than an XDG entry macOS never reads.
 *   Linux   — an XDG autostart entry, started by the desktop session at graphical login. A headless box has no
 *             desktop session and therefore no autostart, so registration says so and names `systemd-run --user`
 *             as the answer there.
 *
 * Everything below is a pure function of the spec plus the launcher, except the four that spawn an OS tool. */

export interface LaunchAgentSpec {
    // Reverse-DNS, launchd's convention — the id `launchctl bootout` and `bootstrap` address it by.
    readonly label: string;
    // Where launchd sends the loop's stdout and stderr. launchd supervises the process it starts, so the loop
    // runs in the foreground and its output has to go somewhere.
    readonly logPath: string;
}

export interface AutostartSpec {
    /* The agent's slug: the XDG autostart file's base name, and the systemd unit named in the headless note.
     * Not the launchd label — that one is reverse-DNS and does not derive from this. */
    readonly id: string;
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
     * `detached` is for Windows, whose Run entry Explorer starts in the INTERACTIVE session — where a console
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

// Exec args are quoted per the desktop-entry grammar.
export const linuxDesktopEntry = (spec: AutostartSpec, launcher: CliLauncher): string =>
    `[Desktop Entry]
Type=Application
Name=${spec.desktopName}
Comment=${spec.desktopComment}
Exec=${quotedCommandLine([...launcher, ...spec.foregroundArgs])}
X-GNOME-Autostart-enabled=true
`;

// RunAtLoad starts it at login (and at bootstrap time). No KeepAlive — a deliberate stop should stay stopped,
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
    <key>StandardOutPath</key><string>${agent.logPath}</string>
    <key>StandardErrorPath</key><string>${agent.logPath}</string>
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
    // RunAtLoad starts too — and which reports why if IT fails, since nothing else is left to try.
    spawnSync("launchctl", ["bootout", `gui/${uid}/${agent.label}`], { stdio: "ignore" });
    if (spawnSync("launchctl", ["bootstrap", `gui/${uid}`, plist], { stdio: "ignore" }).status === 0) {
        return true;
    }
    register("launchctl", ["load", "-w", plist]);
    return true;
};

const registerLinux = async (spec: AutostartSpec, launcher: CliLauncher, log: Log): Promise<void> => {
    const file = linuxDesktopPath(spec);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, linuxDesktopEntry(spec, launcher), { mode: 0o644 });
    if (process.env["XDG_CURRENT_DESKTOP"] === undefined) {
        log(
            `note: this machine has no desktop session, so the autostart entry won't fire. To keep it running: systemd-run --user --unit=${spec.id} ${quotedCommandLine([...launcher, ...spec.foregroundArgs])}`,
        );
    }
};

/* Register the agent to start at login.
 *
 * Returns true only when the OS mechanism ALSO launched it for the CURRENT session (macOS bootstrap does), so
 * the caller can skip its own spawn and avoid running two. Windows and Linux autostart fire at the next login
 * only, so they answer false and the caller covers this session.
 */
export const registerAutostart = async (spec: AutostartSpec, launcher: CliLauncher, log: Log): Promise<boolean> => {
    try {
        if (process.platform === "darwin") {
            // An agent with no LaunchAgent spec says so, rather than writing an XDG entry macOS never reads —
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
            await registerLinux(spec, launcher, log);
            return false;
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
            // uninstall — ignoring that is this branch's `rm --force`.
            spawnSync(regExe(), windowsRunDeleteArgs(spec), { stdio: "ignore" });
            return;
        }
        await rm(linuxDesktopPath(spec), { force: true });
    } catch (error) {
        log(`note: couldn't remove the login-autostart entry for ${spec.id} (${reason(error)}).`);
    }
};
