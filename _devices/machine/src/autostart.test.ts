import { linuxDesktopEntry, windowsRunAddArgs, type CliLauncher } from "@intentic/local-agent";
import { describe, expect, it } from "vitest";
import { MACHINE_AUTOSTART } from "./autostart.js";

// Builders are tested in @intentic/local-agent; this only checks that this agent's spec picks the right argv
// (foreground vs detached), a difference invisible until reboot.
const BINARY: CliLauncher = ["/home/dev/.intentic/machine/bin/intentic-machine"];
const STUB = "/home/dev/.intentic/machine/bin/intentic-launch.exe";

describe("MACHINE_AUTOSTART", () => {
    it("gives a stubless Windows install the detached starter, never the foreground loop", () => {
        // A bare Run entry would park a console window in the interactive session from login to shutdown; bare `run`
        // spawns the hidden loop and exits quickly instead.
        expect(windowsRunAddArgs(MACHINE_AUTOSTART, BINARY).at(-2)).toBe('"/home/dev/.intentic/machine/bin/intentic-machine" "run"');
    });

    it("gives a Windows install with the launcher stub the foreground loop, through the stub", () => {
        // The stub is a GUI-subsystem program: nothing shows on the desktop, and the intermediate `run` process
        // disappears from the logon path.
        expect(windowsRunAddArgs(MACHINE_AUTOSTART, BINARY, STUB).at(-2)).toBe(
            `"${STUB}" "--log" "${MACHINE_AUTOSTART.logPath}" "--" "/home/dev/.intentic/machine/bin/intentic-machine" "run" "--foreground"`,
        );
    });

    it("gives the supervising mechanisms the foreground loop, since they wait on the process they start", () => {
        expect(MACHINE_AUTOSTART.foregroundArgs).toEqual(["run", "--foreground"]);
        expect(linuxDesktopEntry(MACHINE_AUTOSTART, BINARY)).toContain('"run" "--foreground"');
    });

    it("declares a macOS LaunchAgent, which is the only autostart macOS reads", () => {
        expect(MACHINE_AUTOSTART.launchAgent?.label).toBe("dev.intentic.machine");
    });

    // Every mechanism's output must land in the one log file this agent tells people to read, or a failure is
    // undebuggable.
    it("names the agent's own log as the sink every mechanism writes to", () => {
        expect(MACHINE_AUTOSTART.logPath).toMatch(/machine\.log$/);
    });
});
