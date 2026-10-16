import { explain, type Ui } from "@intentic/local-agent";
import { buildRouteMap, type CommandContext } from "@stricli/core";
import { beforeSignInCommand, retireBeforeSignIn } from "./autostart/before-sign-in.js";
import { buildCommand, machineUi } from "./cli-ui.js";
import { runLogPath } from "./config.js";
import { deviceCommands, deviceUninstall } from "./device/commands.js";
import { sandboxRoutes } from "./device/sandbox-cli.js";
import { environmentRoutes, updates } from "./environments/commands.js";
import { keyringCommands } from "./keyring/commands.js";
import { type MachineUpgradeEnd, realMachineIo, upgradeMachine } from "./environments/machine-upgrade.js";
import { runForeground } from "./resident/resident.js";
import { readResident, restartResident, stopResident } from "./resident/supervision.js";
import { status } from "./status.js";
import { syncCommands, syncUninstall } from "./sync/commands.js";
import { doctor } from "./upkeep/doctor.js";
import { upgradeLanded, upgradeStop } from "./upgrade.js";
import { MACHINE_VERSION } from "./version.js";

// intentic-machine: the agent on a user's own device. `device` connects a sandbox to this machine; `sync` mirrors
// folders/ports; both share one resident agent (`run`), `status`, `upgrade`, `updates` and `uninstall`. `sandbox`
// passes ic's own verbs through, for repairing a sandbox on this machine without a browser; `doctor` is the agent's own
// upkeep pass on demand (upkeep/); `keyring` installs and keeps intentic-keyring, a process of its own (keyring/).

interface RunFlags {
    readonly foreground: boolean;
    readonly stop: boolean;
    readonly beforeSignIn: boolean;
}

const run = buildCommand<RunFlags>({
    docs: { brief: "Restart this device's agent: sandbox connections, file sync, port mirroring (setup starts it for you)" },
    parameters: {
        flags: {
            foreground: { kind: "boolean", brief: "Run the agent in this terminal instead of the background" },
            stop: { kind: "boolean", brief: "Stop the background agent" },
            // What Windows' boot task runs (autostart/before-sign-in.ts): a person never types it.
            beforeSignIn: { kind: "boolean", brief: "Run as the agent this PC starts before anyone signs in", default: false, hidden: true },
        },
    },
    async func(this: CommandContext, flags: RunFlags) {
        if (flags.foreground) {
            // The log is long-lived: every line is timestamped since bare lines would be useless.
            // allow(terminal-output): the foreground agent's own log stream, read from a file or a supervisor, not a person's report
            await runForeground((message) => void this.process.stdout.write(`[${new Date().toISOString()}] ${message}\n`), { beforeSignIn: flags.beforeSignIn });
            return;
        }
        const ui = machineUi(this.process);
        if (flags.stop) {
            ui.act("Stopping the background agent");
            const pid = await stopResident();
            // Said because it is not obvious: whatever supervises the agent brings it back, which is what supervising means.
            ui.note("It comes back at your next sign-in, and sooner if this device's supervisor notices it gone.");
            ui.done(pid === undefined ? "The background agent was not running." : `Stopped the background agent (pid ${pid}).`);
            ui.later([["stop it for good", "intentic-machine uninstall"]]);
            return;
        }
        ui.act("Restarting the background agent");
        await restartResident(ui.note);
        const held = await readResident();
        if (held === undefined) {
            throw new Error(
                explain("The background agent did not come back up.", `it stopped while starting; its log is ${runLogPath}.`, "intentic-machine run --foreground"),
            );
        }
        ui.done(`Restarted the background agent (pid ${held.pid}, ${held.build ?? "unknown build"}).`);
    },
});

// Bare version string, not a sentence: the release build and `upgrade` both parse it directly.
const version = buildCommand({
    docs: { brief: "Print this agent's version" },
    parameters: {},
    func(this: CommandContext) {
        // allow(terminal-output): the bare X.Y.Z the release build and `upgrade` parse
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
    docs: { brief: "Update the agent on this whole device (Windows and every WSL distro on it) to the newest release" },
    parameters: {
        flags: {
            force: {
                kind: "boolean",
                brief: "Install the published agent even over one built from source, or onto a release this device rolled back from (both otherwise left alone)",
            },
            level: { kind: "boolean", brief: "Bring every side to the newest release one of them already runs, without asking for a newer one", default: false, hidden: true },
        },
    },
    async func(this: CommandContext, flags: UpgradeFlags) {
        const ui = machineUi(this.process);
        ui.act("Updating the agent on this device");
        await upgradeMachine(realMachineIo(flags, ui.note), flags, ui.note, (ending) => upgradeEnded(ui, ending));
    },
});

// The ending of a machine-wide upgrade as the protocol draws it: a verdict, or a stop that says what to do.
const upgradeEnded = (ui: Ui, ending: MachineUpgradeEnd): void => {
    if (ending.landed) {
        ui.done(ending.said);
        if (ending.outcome?.kind === "current" && ending.outcome.later !== undefined) {
            ui.later([ending.outcome.later]);
        }
        return;
    }
    if (ending.delegated === true) {
        // The Windows side drew its own stop on this terminal; a second one here would only repeat it.
        ui.close();
        process.exitCode = 1;
        return;
    }
    if (ending.legsFailed.length > 0 && (ending.outcome === undefined || upgradeLanded(ending.outcome))) {
        throw new Error(
            explain(
                "The agent was not updated on every side of this device.",
                `${ending.legsFailed.join(", ")} did not finish; the lines above say why.`,
                "intentic-machine upgrade",
            ),
        );
    }
    if (ending.outcome === undefined) {
        throw new Error(explain("The agent was not updated.", "the release channel did not answer, and nothing was changed.", "check the network, then run the same command again."));
    }
    const stop = upgradeStop(ending.outcome);
    throw new Error(explain(stop.headline, stop.problem, stop.fix));
};

// Removes this environment's links and pairings in one command; sync tears down first while its credentials still exist.
const uninstall = buildCommand({
    docs: { brief: "Remove this environment's agent: every sandbox link, every sync pairing, the login entry" },
    parameters: {},
    async func(this: CommandContext) {
        const ui = machineUi(this.process);
        ui.act("Removing the agent from this device");
        // For good: the agent goes even from a device that hosts sandboxes, which it would otherwise stay to keep.
        ui.note(await syncUninstall(ui, undefined, { forGood: true }));
        ui.note(await deviceUninstall(ui, undefined, { forGood: true }));
        await retireBeforeSignIn(ui.note);
        const still = await readResident();
        if (still === undefined) {
            ui.done("Removed the agent. Nothing intentic stays running on this device.");
            return;
        }
        ui.note("Run the uninstall inside each of this device's WSL distros to remove it entirely.");
        ui.done(`Removed this side's links. The agent keeps running (pid ${still.pid}) only to keep this device's WSL distros running.`);
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
            docs: { brief: "Mirror a sandbox's files and ports onto this device (the Desktop sync card)" },
        }),
        // intentic-keyring, the vault beside this agent (keyring/): installed, kept and asked from here, by a person or
        // the desktop app, never by a sandbox, which reaches it only through the relayed procedures (keyring/relay.ts).
        keyring: buildRouteMap({
            routes: keyringCommands,
            docs: { brief: "The password vault on this computer, which types and hands over secrets for your sandboxes at your word" },
        }),
        sandbox: sandboxRoutes,
        environment: environmentRoutes,
        run,
        "before-sign-in": beforeSignInCommand,
        status,
        doctor,
        version,
        upgrade,
        updates,
        uninstall,
    },
    docs: { brief: "intentic-machine, connect this device to your intentic sandboxes", hideRoute: { environment: true } },
});
