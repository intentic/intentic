import { linuxDesktopEntry, windowsRunAddArgs, type CliLauncher } from "@intentic/local-agent";
import { describe, expect, it } from "vitest";
import { MACHINE_AUTOSTART } from "./autostart.js";

/* The builders themselves are covered in @intentic/local-agent; what belongs here is that THIS agent's spec
 * says the right things, because the two argv are not interchangeable and the difference is invisible until a
 * user reboots. */
const BINARY: CliLauncher = ["/home/dev/.intentic/machine/bin/intentic-machine"];
const STUB = "/home/dev/.intentic/machine/bin/intentic-launch.exe";

describe("MACHINE_AUTOSTART", () => {
    it("gives a stubless Windows install the detached starter, never the foreground loop", () => {
        // Explorer runs a Run entry in the interactive session, where a console program owns a console window for
        // as long as it lives: registering `run --foreground` bare would park a black window on the desktop from
        // login until shutdown. Bare `run` spawns the hidden loop and exits within a second.
        expect(windowsRunAddArgs(MACHINE_AUTOSTART, BINARY).at(-2)).toBe('"/home/dev/.intentic/machine/bin/intentic-machine" "run"');
    });

    it("gives a Windows install with the launcher stub the foreground loop, through the stub", () => {
        // The stub is a GUI-subsystem program: nothing is mapped on the desktop, the loop gets a windowless
        // console, and the intermediate `run` process disappears from the logon path.
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

    // Whichever mechanism supervises the loop, its output has to land in the one file this agent tells people to
    // read: a loop whose log lives somewhere the product never names is a loop nobody can debug.
    it("names the agent's own log as the sink every mechanism writes to", () => {
        expect(MACHINE_AUTOSTART.logPath).toMatch(/machine\.log$/);
    });
});
