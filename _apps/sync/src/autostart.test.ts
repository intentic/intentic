import { describe, expect, it } from "vitest";
import { linuxDesktopEntry, macPlistXml, windowsRunAddArgs, windowsRunDeleteArgs } from "./autostart.js";
import type { CliLauncher } from "./mirror.js";

// The three OS autostart entries are string/argv builders (the side-effecting register/unregister spawn the OS
// tools, exercised in the field) — pin that each launches `mirror --watch` at login with the launcher it was
// handed, VERBATIM. Both launcher shapes are covered because the released install is the compiled one, and it
// is exactly the shape a hardcoded `execPath + argv[1]` used to corrupt: the binary re-injects its own entry, so
// an entry written into the autostart line lands where the command name is read and mirroring never starts.
const NODE: CliLauncher = ["/usr/bin/node", "/opt/intentic/sync/dist/cli.js"];
const BINARY: CliLauncher = ["/home/dev/.intentic/sync/bin/intentic-sync"];

describe("macPlistXml", () => {
    it("runs the launcher with `mirror --watch`, RunAtLoad, and logs to mirror.log", () => {
        const plist = macPlistXml(NODE);
        expect(plist).toContain("<key>Label</key><string>dev.intentic.sync-mirror</string>");
        expect(plist).toContain("<string>/usr/bin/node</string>");
        expect(plist).toContain("<string>/opt/intentic/sync/dist/cli.js</string>");
        expect(plist).toContain("<string>mirror</string>");
        expect(plist).toContain("<string>--watch</string>");
        expect(plist).toContain("<key>RunAtLoad</key><true/>");
        expect(plist).toContain("mirror.log");
    });

    it("passes a compiled binary no entry argument", () => {
        const plist = macPlistXml(BINARY);
        expect(plist).toContain("<string>/home/dev/.intentic/sync/bin/intentic-sync</string>");
        expect(plist).not.toContain("cli.js");
        // The command must be the FIRST argument after the executable, or stricli reads the wrong token.
        expect(plist.indexOf("<string>mirror</string>")).toBeGreaterThan(plist.indexOf("intentic-sync</string>"));
    });
});

describe("linuxDesktopEntry", () => {
    it("is an autostart Application entry that quotes the launcher and runs `mirror --watch`", () => {
        const entry = linuxDesktopEntry(NODE);
        expect(entry).toContain("Type=Application");
        expect(entry).toContain('Exec="/usr/bin/node" "/opt/intentic/sync/dist/cli.js" "mirror" "--watch"');
        expect(entry).toContain("X-GNOME-Autostart-enabled=true");
    });

    it("execs a compiled binary with the command directly", () => {
        expect(linuxDesktopEntry(BINARY)).toContain('Exec="/home/dev/.intentic/sync/bin/intentic-sync" "mirror" "--watch"');
    });
});

// Windows registers through the CURRENT USER's Run key — the same mechanism Mutagen's `daemon register` uses,
// and the reason it kept succeeding where our schtasks call could not: `/SC ONLOGON` triggers for any user on
// the machine (elevation), and schtasks always wants a password it has no stdin to read.
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

describe("windowsRunAddArgs", () => {
    it("writes a forced per-user Run value that starts the watcher with the launcher it was handed", () => {
        expect(windowsRunAddArgs(NODE)).toEqual([
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
        expect(windowsRunAddArgs(BINARY).at(-2)).toBe('"/home/dev/.intentic/sync/bin/intentic-sync" "mirror"');
    });

    it("never registers the foreground loop — Explorer would leave its console window on screen all session", () => {
        expect(windowsRunAddArgs(BINARY).join(" ")).not.toContain("--watch");
    });

    it("deletes exactly the value it adds, or uninstall leaves mirroring resurrecting at every login", () => {
        const added = windowsRunAddArgs(BINARY);
        expect(windowsRunDeleteArgs()).toEqual(["delete", added[1], "/v", added[3], "/f"]);
    });
});
