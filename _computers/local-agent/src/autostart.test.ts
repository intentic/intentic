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

/* The three OS autostart entries are string/argv builders — the side-effecting register/unregister spawn the OS
 * tools and are exercised in the field. What is pinned here is that each launches the spec's command at login
 * with the launcher it was handed, VERBATIM. Both launcher shapes are covered because the released install is
 * the compiled one, and it is exactly the shape a hardcoded `execPath + argv[1]` used to corrupt. */
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
        // The command must be the FIRST argument after the executable, or stricli reads the wrong token.
        expect(plist.indexOf("<string>mirror</string>")).toBeGreaterThan(plist.indexOf("intentic-sync</string>"));
    });
});

/* The mechanism that actually works on the machines that need autostart most. An XDG entry is started by the
 * desktop session at graphical login, so on a headless box — a server, a container, every WSL distro — it can
 * never fire; a user unit is what systemd is for. */
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

    // A deliberate `systemctl --user stop` must stay stopped — the same call the macOS LaunchAgent makes by
    // omitting KeepAlive. `always` would fight the user.
    it("restarts on failure but not on a clean stop", () => {
        const unit = systemdUserUnit(SPEC, BINARY);
        expect(unit).toContain("Restart=on-failure");
        expect(unit).not.toContain("Restart=always");
    });

    /* A user unit does NOT inherit a login shell's environment. Both agents shell out to `git` and `ssh` on every
     * tick (the git bridge) and Mutagen's transport needs ssh too, so a unit that starts from systemd's minimal
     * PATH is one whose bridge silently fails every pass. */
    it("sets a PATH that includes the shells-out targets", () => {
        const unit = systemdUserUnit(SPEC, BINARY);
        expect(unit).toContain(`Environment=PATH=${homedir()}/.local/bin:/usr/local/bin:/usr/bin:/bin`);
    });

    /* THE LOG THE AGENT ADVERTISES, not the journal. A unit without these lines sends the loop's output to
     * journald while `intentic-sync status`, every failure note and the docs all name the agent's own file — so on
     * a systemd machine (most Linux desktops, every WSL distro with systemd on) that file stopped growing the day
     * autostart started working, and a watcher whose loop had died was diagnosable only by someone who already
     * knew to reach for journalctl. `append:` and not `file:`, or each restart truncates the pass that explains
     * why it restarted. */
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

// Windows registers through the CURRENT USER's Run key — the same mechanism Mutagen's `daemon register` uses,
// and the reason it kept succeeding where a schtasks call could not: `/SC ONLOGON` triggers for any user on the
// machine (elevation), and schtasks always wants a password it has no stdin to read.
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

describe("windowsRunAddArgs", () => {
    it("writes a forced per-user Run value that starts the DETACHED command with the launcher it was handed", () => {
        expect(windowsRunAddArgs(SPEC, NODE)).toEqual([
            "add",
            RUN_KEY,
            "/v",
            "IntenticSyncMirror",
            "/t",
            "REG_SZ",
            "/d",
            '"/usr/bin/node" "/opt/intentic/sync/dist/cli.js" "mirror"',
            "/f",
        ]);
    });

    it("registers a compiled binary with the command directly", () => {
        expect(windowsRunAddArgs(SPEC, BINARY).at(-2)).toBe('"/home/dev/.intentic/sync/bin/intentic-sync" "mirror"');
    });

    it("never registers the foreground loop — Explorer would leave its console window on screen all session", () => {
        expect(windowsRunAddArgs(SPEC, BINARY).join(" ")).not.toContain("--watch");
    });

    it("deletes exactly the value it adds, or uninstall leaves the agent resurrecting at every login", () => {
        const added = windowsRunAddArgs(SPEC, BINARY);
        expect(windowsRunDeleteArgs(SPEC)).toEqual(["delete", added[1], "/v", added[3], "/f"]);
    });
});
