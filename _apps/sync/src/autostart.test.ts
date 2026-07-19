import { describe, expect, it } from "vitest";
import { linuxDesktopEntry, macPlistXml, windowsTaskArgs } from "./autostart.js";

const CLI = "/opt/homebrew/lib/node_modules/@intentic/sync/dist/cli.js";

// The three OS autostart entries are string/argv builders (the side-effecting register/unregister spawn the OS
// tools, exercised in the field) — pin that each launches `mirror --watch` at login with the node + cli paths.

describe("macPlistXml", () => {
    it("runs node + cli with `mirror --watch`, RunAtLoad, and logs to mirror.log", () => {
        const plist = macPlistXml(CLI);
        expect(plist).toContain("<key>Label</key><string>dev.intentic.sync-mirror</string>");
        expect(plist).toContain(`<string>${process.execPath}</string>`);
        expect(plist).toContain(`<string>${CLI}</string>`);
        expect(plist).toContain("<string>mirror</string>");
        expect(plist).toContain("<string>--watch</string>");
        expect(plist).toContain("<key>RunAtLoad</key><true/>");
        expect(plist).toContain("mirror.log");
    });
});

describe("linuxDesktopEntry", () => {
    it("is an autostart Application entry that quotes node + cli and runs `mirror --watch`", () => {
        const entry = linuxDesktopEntry(CLI);
        expect(entry).toContain("Type=Application");
        expect(entry).toContain(`Exec="${process.execPath}" "${CLI}" mirror --watch`);
        expect(entry).toContain("X-GNOME-Autostart-enabled=true");
    });
});

describe("windowsTaskArgs", () => {
    it("creates a forced ONLOGON task whose action runs node + cli with `mirror --watch`", () => {
        const args = windowsTaskArgs(CLI);
        expect(args).toEqual([
            "/Create",
            "/TN",
            "IntenticSyncMirror",
            "/SC",
            "ONLOGON",
            "/F",
            "/TR",
            `"${process.execPath}" "${CLI}" mirror --watch`,
        ]);
    });
});
