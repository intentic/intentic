import { describe, expect, it } from "vitest";
import { linuxDesktopEntry, macPlistXml, windowsTaskArgs } from "./autostart.js";
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

describe("windowsTaskArgs", () => {
    it("creates a forced ONLOGON task whose action runs the launcher with `mirror --watch`", () => {
        expect(windowsTaskArgs(NODE)).toEqual([
            "/Create",
            "/TN",
            "IntenticSyncMirror",
            "/SC",
            "ONLOGON",
            "/F",
            "/TR",
            '"/usr/bin/node" "/opt/intentic/sync/dist/cli.js" "mirror" "--watch"',
        ]);
    });

    it("registers a compiled binary with the command directly", () => {
        expect(windowsTaskArgs(BINARY).at(-1)).toBe('"/home/dev/.intentic/sync/bin/intentic-sync" "mirror" "--watch"');
    });
});
