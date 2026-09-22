import { buildCommand, buildRouteMap, type CommandContext } from "@stricli/core";
import { deviceCommands, deviceUninstall } from "./device/commands.js";
import { environmentRoutes, updates } from "./environments/commands.js";
import { realMachineIo, upgradeMachine } from "./environments/machine-upgrade.js";
import { runForeground } from "./resident.js";
import { readResident, restartResident, stopResident } from "./supervision.js";
import { status } from "./status.js";
import { syncCommands, syncUninstall } from "./sync/commands.js";
import { MACHINE_VERSION } from "./version.js";

// intentic-machine: the agent on a user's own device. `device` connects a sandbox to this machine; `sync` mirrors
// folders/ports; both share one resident agent (`run`), `status`, `upgrade`, `updates` and `uninstall`.

interface RunFlags {
    readonly foreground: boolean;
    readonly stop: boolean;
}

const run = buildCommand<RunFlags>({
    docs: { brief: "Restart this machine's agent: sandbox connections, file sync, port mirroring (setup starts it for you)" },
    parameters: {
        flags: {
            foreground: { kind: "boolean", brief: "Run the agent in this terminal instead of the background" },
            stop: { kind: "boolean", brief: "Stop the background agent" },
        },
    },
    async func(this: CommandContext, flags: RunFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        if (flags.stop) {
            const pid = await stopResident();
            out(pid === undefined ? "not running." : `stopped (pid ${pid}).`);
            // Said because it is not obvious: whatever supervises the agent brings it back, which is what supervising means.
            out("It comes back at your next sign-in, and sooner if this machine's supervisor notices it gone. `intentic-machine uninstall` is what stops it for good.");
            return;
        }
        if (!flags.foreground) {
            await restartResident(out);
            const held = await readResident();
            out(held === undefined ? "the agent did not come back up: check its log." : `running (pid ${held.pid}, ${held.build ?? "unknown build"}).`);
            return;
        }
        // The log is long-lived: every line is timestamped since bare lines would be useless.
        await runForeground((message) => void this.process.stdout.write(`[${new Date().toISOString()}] ${message}\n`));
    },
});

// Bare version string, not a sentence: the release build and `upgrade` both parse it directly.
const version = buildCommand({
    docs: { brief: "Print this agent's version" },
    parameters: {},
    func(this: CommandContext) {
        this.process.stdout.write(`${MACHINE_VERSION}\n`);
        return Promise.resolve();
    },
});

interface UpgradeFlags {
    readonly force: boolean;
    readonly level: boolean;
}

// The whole PC, never one side of it: every environment ends on one release, and a side that could not says why.
const upgrade = buildCommand<UpgradeFlags>({
    docs: { brief: "Upgrade the agent on this whole machine (Windows and every WSL distro on it) to the newest release" },
    parameters: {
        flags: {
            force: {
                kind: "boolean",
                brief: "Install the published agent even over one built from source (which is otherwise left alone)",
            },
            level: { kind: "boolean", brief: "Bring every side to the newest release one of them already runs, without asking for a newer one", default: false, hidden: true },
        },
    },
    async func(this: CommandContext, flags: UpgradeFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        if (!(await upgradeMachine(realMachineIo(flags, out), flags, out))) {
            process.exitCode = 1;
        }
    },
});

// Removes this environment's links and pairings in one command; sync tears down first while its credentials still exist.
const uninstall = buildCommand({
    docs: { brief: "Remove this environment's agent: every sandbox link, every sync pairing, the login entry" },
    parameters: {},
    async func(this: CommandContext) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        await syncUninstall(out);
        await deviceUninstall(out);
        const still = await readResident();
        out(
            still === undefined
                ? "Nothing intentic stays resident here."
                : `The agent keeps running (pid ${still.pid}) only to keep this PC's WSL distros running; uninstall inside each of them to remove it entirely.`,
        );
    },
});

export const commands = buildRouteMap({
    routes: {
        device: buildRouteMap({
            routes: deviceCommands,
            docs: { brief: "Let a sandbox work on this device (the Connect-this-device card)" },
        }),
        sync: buildRouteMap({
            routes: syncCommands,
            docs: { brief: "Mirror a sandbox's files and ports onto this machine (the Desktop sync card)" },
        }),
        environment: environmentRoutes,
        run,
        status,
        version,
        upgrade,
        updates,
        uninstall,
    },
    docs: { brief: "intentic-machine, connect this device to your intentic sandboxes", hideRoute: { environment: true } },
});
