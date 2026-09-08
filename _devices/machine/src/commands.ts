import { buildCommand, buildRouteMap, type CommandContext } from "@stricli/core";
import { deviceCommands, deviceUninstall } from "./device/commands.js";
import { ensureWindowsLauncher, machineUpgradeExec } from "./install.js";
import { reconcileResidency, runForeground, stopResident } from "./resident.js";
import { status } from "./status.js";
import { syncCommands, syncUninstall } from "./sync/commands.js";
import { assetUrl, runUpgrade, upgradeMessage } from "./upgrade.js";
import { MACHINE_VERSION } from "./version.js";

// intentic-machine: the agent on a user's own device. `device` connects a sandbox to this machine; `sync` mirrors
// folders/ports; both share one resident loop (`run`), `status`, `upgrade`, and `uninstall`.

interface RunFlags {
    readonly foreground: boolean;
    readonly stop: boolean;
}

const run = buildCommand<RunFlags>({
    docs: { brief: "Run this machine's agent: sandbox connections, file sync, port mirroring (setup starts this for you)" },
    parameters: {
        flags: {
            foreground: { kind: "boolean", brief: "Run the loop in this terminal instead of the background" },
            stop: { kind: "boolean", brief: "Stop the background loop" },
        },
    },
    async func(this: CommandContext, flags: RunFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        if (flags.stop) {
            const pid = await stopResident();
            out(pid === undefined ? "not running." : `stopped (pid ${pid}).`);
            return;
        }
        if (!flags.foreground) {
            // Reconcile also repairs a missing/stale login entry, so `run` after a botched install fixes it too.
            await reconcileResidency(out);
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

// Moves this machine onto the current agent without a pairing token, unlike the old enroll-to-update flow. Checked
// before swapping; rolled back automatically if the new agent doesn't stay up (upgrade.ts).
interface UpgradeFlags {
    readonly force: boolean;
}

const upgrade = buildCommand<UpgradeFlags>({
    docs: { brief: "Download and install the current agent, then restart the background loop" },
    parameters: {
        flags: {
            force: {
                kind: "boolean",
                brief: "Install the published agent even over one built from source (which is otherwise left alone)",
            },
        },
    },
    async func(this: CommandContext, flags: UpgradeFlags) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        out(upgradeMessage(await runUpgrade(machineUpgradeExec(out), assetUrl, MACHINE_VERSION, flags.force, out)));
        // The launcher stub ships and updates with the agent, so an upgrade refreshes both.
        await ensureWindowsLauncher(out);
    },
});

// Removes both halves in one command; sync tears down first while credentials still exist, then device's reconcile
// retires the loop and the login entry.
const uninstall = buildCommand({
    docs: { brief: "Remove this machine's agent entirely: every sandbox link, every sync pairing, the login entry" },
    parameters: {},
    async func(this: CommandContext) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        await syncUninstall(out);
        await deviceUninstall(out);
        out("Nothing intentic stays resident on this machine.");
    },
});

export const commands = {
    device: buildRouteMap({
        routes: deviceCommands,
        docs: { brief: "Let a sandbox work on this device (the Connect-this-device card)" },
    }),
    sync: buildRouteMap({
        routes: syncCommands,
        docs: { brief: "Mirror a sandbox's files and ports onto this machine (the Desktop sync card)" },
    }),
    run,
    status,
    version,
    upgrade,
    uninstall,
};
