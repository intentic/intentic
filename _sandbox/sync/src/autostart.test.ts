import { linuxDesktopEntry, windowsRunAddArgs, type CliLauncher } from "@intentic/local-agent";
import { describe, expect, it } from "vitest";
import { MIRROR_AUTOSTART } from "./autostart.js";

/* The builders themselves are covered in @intentic/local-agent; what belongs here is that THIS agent's spec
 * says the right things, because the two argv are not interchangeable and the difference is invisible until a
 * user reboots. */
const BINARY: CliLauncher = ["/home/dev/.intentic/sync/bin/intentic-sync"];

describe("MIRROR_AUTOSTART", () => {
    it("gives Windows the detached starter, never the foreground loop", () => {
        // Explorer runs a Run entry in the interactive session, where a console program owns a console window for
        // as long as it lives: registering `mirror --watch` would park a black window on the desktop from login
        // until shutdown. Bare `mirror` spawns the hidden watcher and exits within a second.
        expect(windowsRunAddArgs(MIRROR_AUTOSTART, BINARY).at(-2)).toBe('"/home/dev/.intentic/sync/bin/intentic-sync" "mirror"');
    });

    it("gives the supervising mechanisms the watch loop, since they wait on the process they start", () => {
        expect(MIRROR_AUTOSTART.foregroundArgs).toEqual(["mirror", "--watch"]);
        expect(linuxDesktopEntry(MIRROR_AUTOSTART, BINARY)).toContain('"mirror" "--watch"');
    });

    it("declares a macOS LaunchAgent, which is the only autostart macOS reads", () => {
        expect(MIRROR_AUTOSTART.launchAgent?.label).toBe("dev.intentic.sync-mirror");
    });

    // Whichever mechanism supervises the loop, its output has to land in the one file this agent tells people to
    // read: a watcher whose log lives somewhere the product never names is a watcher nobody can debug.
    it("names the watcher's own log as the sink every mechanism writes to", () => {
        expect(MIRROR_AUTOSTART.logPath).toMatch(/mirror\.log$/);
    });
});
