import { homedir } from "node:os";
import { HOST_STATE_ROOT } from "@intentic/constants";
import { describe, expect, it } from "vitest";
import {
    linuxDesktopEntry,
    macLaunchAgentXml,
    systemdUserUnit,
    windowsRunAddArgs,
    windowsRunDeleteArgs,
    windowsTaskCreateArgs,
    windowsTaskDeleteArgs,
    windowsTaskXml,
    type AutostartSpec,
    type LaunchAgentSpec,
} from "./autostart.js";
import { LOG_ROTATE_BYTES } from "./detached.js";
import type { CliLauncher } from "./launcher.js";

// Tests the string/argv builders only; register/unregister side effects are exercised in the field. Pins that each
// launches the spec's command verbatim, covering both launcher shapes (script, compiled binary).
const NODE: CliLauncher = ["/usr/bin/node", `${HOST_STATE_ROOT}/sync/dist/cli.js`];
const BINARY: CliLauncher = ["/home/dev/.intentic/sync/bin/intentic-sync"];

const LAUNCH_AGENT: LaunchAgentSpec = { label: "dev.intentic.sync-mirror" };
const LOG = "/home/dev/.intentic/sync/mirror.log";

const SPEC: AutostartSpec = {
    id: "intentic-sync-mirror",
    windowsRunValue: "IntenticSyncMirror",
    desktopName: "Intentic Sync Mirror",
    desktopComment: "Mirror the intentic sandbox's workspace ports onto localhost",
    logPath: LOG,
    launchAgent: LAUNCH_AGENT,
    detachedArgs: ["mirror"],
    foregroundArgs: ["mirror", "--watch"],
    failureNote: (reason) => `nope: ${reason}`,
};

describe("macLaunchAgentXml", () => {
    it("runs the launcher with the FOREGROUND args, RunAtLoad, and logs where the spec says", () => {
        const plist = macLaunchAgentXml(SPEC, LAUNCH_AGENT, NODE);
        expect(plist).toContain("<key>Label</key><string>dev.intentic.sync-mirror</string>");
        expect(plist).toContain("<string>/usr/bin/node</string>");
        expect(plist).toContain("<string>/opt/intentic/sync/dist/cli.js</string>");
        expect(plist).toContain("<string>mirror</string>");
        expect(plist).toContain("<string>--watch</string>");
        expect(plist).toContain("<key>RunAtLoad</key><true/>");
        expect(plist).toContain("mirror.log");
    });

    it("passes a compiled binary no entry argument", () => {
        const plist = macLaunchAgentXml(SPEC, LAUNCH_AGENT, BINARY);
        expect(plist).toContain("<string>/home/dev/.intentic/sync/bin/intentic-sync</string>");
        expect(plist).not.toContain("cli.js");
        // Command must be the first arg after the executable, or stricli reads the wrong token.
        expect(plist.indexOf("<string>mirror</string>")).toBeGreaterThan(plist.indexOf("intentic-sync</string>"));
    });

    // The same bargain systemd's Restart=on-failure makes, and the reason it can be made here: the agent exits 0 for
    // every deliberate stop. A bare <true/> would restart one, which is what makes `run --stop` mean nothing.
    it("restarts a crashed agent but leaves a clean exit stopped", () => {
        const plist = macLaunchAgentXml(SPEC, LAUNCH_AGENT, BINARY);
        expect(plist).toContain("<key>KeepAlive</key>");
        expect(plist).toContain("<dict><key>SuccessfulExit</key><false/></dict>");
        expect(plist).not.toContain("<key>KeepAlive</key><true/>");
    });
});

// An XDG autostart entry needs a graphical login and never fires on a headless box (server, container, WSL); a
// systemd user unit does.
describe("systemdUserUnit", () => {
    it("runs the launcher with the FOREGROUND args, since systemd supervises what it starts", () => {
        const unit = systemdUserUnit(SPEC, NODE);
        expect(unit).toContain('ExecStart="/usr/bin/node" "/opt/intentic/sync/dist/cli.js" "mirror" "--watch"');
        expect(unit).toContain("Type=simple");
    });

    it("execs a compiled binary with the command directly", () => {
        expect(systemdUserUnit(SPEC, BINARY)).toContain('ExecStart="/home/dev/.intentic/sync/bin/intentic-sync" "mirror" "--watch"');
    });

    it("is wanted by default.target, or `enable` has nothing to hook it to at boot", () => {
        expect(systemdUserUnit(SPEC, BINARY)).toContain("WantedBy=default.target");
    });

    // Restart=on-failure, not always, so a deliberate stop stays stopped; the agent must exit non-zero on a signal, or
    // the stop looks clean.
    it("restarts on failure but not on a clean stop", () => {
        const unit = systemdUserUnit(SPEC, BINARY);
        expect(unit).toContain("Restart=on-failure");
        expect(unit).not.toContain("Restart=always");
    });

    // Without StartLimitIntervalSec=0, systemd gives up after a few restarts and silently parks the unit in `failed`.
    it("never gives up on a unit that keeps restarting", () => {
        expect(systemdUserUnit(SPEC, BINARY)).toContain("StartLimitIntervalSec=0");
    });

    // systemd treats SIGHUP/SIGINT/SIGTERM/SIGPIPE as a clean exit; RestartForceExitStatus overrides that so a
    // signal-killed agent still restarts.
    it("forces a restart after the signals systemd would call a clean exit", () => {
        const unit = systemdUserUnit(SPEC, BINARY);
        expect(unit).toContain("RestartForceExitStatus=SIGHUP SIGINT SIGTERM SIGPIPE");
    });

    // A systemd user unit does not inherit a login shell's PATH; both agents shell out to git/ssh, so PATH must include
    // those tools explicitly.
    it("sets a PATH that includes the shells-out targets", () => {
        const unit = systemdUserUnit(SPEC, BINARY);
        expect(unit).toContain(`Environment=PATH=${homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin`);
    });

    // Routes agent output to the agent's own log, not journald, matching what `status` and the docs point to. `append:`,
    // not `file:`, keeps the log across restarts.
    it("writes the agent's output to the agent's own log, appending across restarts", () => {
        const unit = systemdUserUnit(SPEC, BINARY);
        expect(unit).toContain(`StandardOutput=append:${LOG}`);
        expect(unit).toContain(`StandardError=append:${LOG}`);
    });

    // Appending across restarts is what makes the log useful and what makes it grow forever. systemd opens the file,
    // so the roll has to happen before it does — and be allowed to fail (`-`), since a log that will not roll must
    // never be the reason the agent does not start.
    it("rolls an oversized log before systemd opens it, and starts anyway if it cannot", () => {
        const unit = systemdUserUnit(SPEC, BINARY);
        expect(unit).toContain(`ExecStartPre=-/bin/sh -c '[ -f "${LOG}" ]`);
        expect(unit).toContain(`-ge ${LOG_ROTATE_BYTES} ] && mv -f "${LOG}" "${LOG}.1"'`);
    });
});

describe("linuxDesktopEntry", () => {
    it("is an autostart Application entry that quotes the launcher and runs the foreground args", () => {
        const entry = linuxDesktopEntry(SPEC, NODE);
        expect(entry).toContain("Type=Application");
        expect(entry).toContain("Name=Intentic Sync Mirror");
        expect(entry).toContain('Exec="/usr/bin/node" "/opt/intentic/sync/dist/cli.js" "mirror" "--watch"');
        expect(entry).toContain("X-GNOME-Autostart-enabled=true");
    });

    it("execs a compiled binary with the command directly", () => {
        expect(linuxDesktopEntry(SPEC, BINARY)).toContain('Exec="/home/dev/.intentic/sync/bin/intentic-sync" "mirror" "--watch"');
    });
});

// HKCU Run key, like Mutagen's daemon register: the UNSUPERVISED fallback, for a machine with no launcher stub beside
// the agent or one whose Task Scheduler refuses the registration below.
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const STUB = "C:\\Users\\dev\\.intentic\\sync\\bin\\intentic-launch.exe";

// What the Run key cannot do: come back. A logon trigger alone still leaves an agent that died at 10am dead until
// tomorrow's sign-in, so the supervision here is three separate mechanisms and every one of them is load-bearing.
describe("windowsTaskXml", () => {
    const xml = windowsTaskXml(SPEC, BINARY, STUB, "OMEN\\radar");

    // A task is "running" only while its ACTION process is. Without --wait the stub exits immediately, the task reads
    // as finished the instant it starts, and every watchdog repetition launches another agent.
    it("holds the task open for as long as the agent runs", () => {
        expect(xml).toContain(`<Command>${STUB}</Command>`);
        // Quotes reach the file escaped, since this is XML; Task Scheduler hands the action the decoded string, which
        // is the command line asserted here whole.
        const escaped = /<Arguments>(.*)<\/Arguments>/.exec(xml)?.[1] ?? "";
        expect(escaped.replaceAll("&quot;", `"`)).toBe(
            `"--log" "${LOG}" "--wait" "--" "/home/dev/.intentic/sync/bin/intentic-sync" "mirror" "--watch"`,
        );
    });

    it("starts at this user's sign-in, as this user, without asking for a password", () => {
        expect(xml).toContain("<LogonTrigger>");
        expect(xml).toContain("<UserId>OMEN\\radar</UserId>");
        // InteractiveToken is the principal that needs no stored credential; RunLevel is what keeps it unelevated.
        expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
        expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
    });

    // The failure Task Scheduler itself notices: a non-zero action. Three fast tries, then the watchdog below owns it.
    it("restarts a failed agent on its own", () => {
        expect(xml).toContain("<RestartOnFailure>");
        expect(xml).toContain("<Interval>PT1M</Interval>");
        expect(xml).toContain("<Count>3</Count>");
    });

    // The failure it does NOT notice: an agent killed outright, or one that exited 0 for a reason that has passed.
    // The repetition re-starts the task forever, and IgnoreNew is what makes that a no-op while the agent is healthy
    // rather than a new agent every five minutes.
    it("re-checks forever, and a check while the agent is up does nothing", () => {
        expect(xml).toContain("<Interval>PT5M</Interval>");
        expect(xml).toContain("<StopAtDurationEnd>false</StopAtDurationEnd>");
        expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    });

    // A resident agent runs for weeks on a laptop that sleeps, unplugs and locks. Every default that would stop it is
    // turned off here, and PT0S is Task Scheduler's spelling of "no time limit".
    it("is never stopped for running long, being on battery, or the machine being busy", () => {
        expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
        expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
        expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
        expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
        expect(xml).toContain("<StopOnIdleEnd>false</StopOnIdleEnd>");
    });

    // schtasks reads the file as UTF-16 because the declaration says so; a mismatch is rejected with an error that
    // blames the task's values rather than its bytes.
    it("declares the encoding its bytes are written in", () => {
        expect(xml.startsWith(`<?xml version="1.0" encoding="UTF-16"?>`)).toBe(true);
    });

    it("deletes exactly the task it creates, or uninstall leaves it resurrecting every five minutes", () => {
        expect(windowsTaskCreateArgs(SPEC, "C:\\Temp\\t.xml")).toEqual(["/create", "/tn", "IntenticSyncMirror", "/xml", "C:\\Temp\\t.xml", "/f"]);
        expect(windowsTaskDeleteArgs(SPEC)).toEqual(["/delete", "/tn", "IntenticSyncMirror", "/f"]);
    });
});

describe("windowsRunAddArgs", () => {
    // The stub is a GUI-subsystem binary launched with CREATE_NO_WINDOW: no console flashes at logon, and agent output
    // goes to the log.
    it("starts the FOREGROUND agent through the stub, logging where the spec says", () => {
        expect(windowsRunAddArgs(SPEC, BINARY, STUB)).toEqual([
            "add",
            RUN_KEY,
            "/v",
            "IntenticSyncMirror",
            "/t",
            "REG_SZ",
            "/d",
            `"${STUB}" "--log" "${LOG}" "--" "/home/dev/.intentic/sync/bin/intentic-sync" "mirror" "--watch"`,
            "/f",
        ]);
    });

    it("hands the stub a node invocation whole, entry script and all", () => {
        expect(windowsRunAddArgs(SPEC, NODE, STUB).at(-2)).toBe(
            `"${STUB}" "--log" "${LOG}" "--" "/usr/bin/node" "/opt/intentic/sync/dist/cli.js" "mirror" "--watch"`,
        );
    });

    // No stub (dev checkout, no compiled binary): falls back to the detached command, since a foreground agent without
    // a stub would leave a console window open for the session.
    it("falls back to the detached command when no stub is installed", () => {
        expect(windowsRunAddArgs(SPEC, NODE).at(-2)).toBe('"/usr/bin/node" "/opt/intentic/sync/dist/cli.js" "mirror"');
        expect(windowsRunAddArgs(SPEC, BINARY).at(-2)).toBe('"/home/dev/.intentic/sync/bin/intentic-sync" "mirror"');
        expect(windowsRunAddArgs(SPEC, BINARY).join(" ")).not.toContain("--watch");
    });

    it("deletes exactly the value it adds, or uninstall leaves the agent resurrecting at every login", () => {
        const added = windowsRunAddArgs(SPEC, BINARY, STUB);
        expect(windowsRunDeleteArgs(SPEC)).toEqual(["delete", added[1], "/v", added[3], "/f"]);
    });
});
