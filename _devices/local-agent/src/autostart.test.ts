import { homedir } from "node:os";
import { HOST_STATE_ROOT } from "@intentic/constants";
import { describe, expect, it } from "vitest";
import {
    linuxDesktopEntry,
    macLaunchAgentXml,
    systemdUserUnit,
    windowsRunAddArgs,
    windowsRunDeleteArgs,
    type AutostartSpec,
    type LaunchAgentSpec,
} from "./autostart.js";
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

    // Routes loop output to the agent's own log, not journald, matching what `status` and the docs point to. `append:`,
    // not `file:`, keeps the log across restarts.
    it("writes the loop's output to the agent's own log, appending across restarts", () => {
        const unit = systemdUserUnit(SPEC, BINARY);
        expect(unit).toContain(`StandardOutput=append:${LOG}`);
        expect(unit).toContain(`StandardError=append:${LOG}`);
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

// HKCU Run key, like Mutagen's daemon register; schtasks needs a password with no stdin to give it.
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

const STUB = "C:\\Users\\dev\\.intentic\\sync\\bin\\intentic-launch.exe";

describe("windowsRunAddArgs", () => {
    // The stub is a GUI-subsystem binary launched with CREATE_NO_WINDOW: no console flashes at logon, and loop output
    // goes to the log.
    it("starts the FOREGROUND loop through the stub, logging where the spec says", () => {
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

    // No stub (dev checkout, no compiled binary): falls back to the detached command, since a foreground loop without
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
