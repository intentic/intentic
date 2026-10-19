import type { CommandContext } from "@stricli/core";
import { retireBeforeSignIn } from "../autostart/before-sign-in.js";
import { buildCommand, machineUi } from "../cli-ui.js";
import { deviceUninstall } from "../device/commands.js";
import { readResident } from "../resident/supervision.js";
import { syncUninstall } from "../sync/commands.js";
import { purgeChoice } from "./plan.js";
import { purgeAgent } from "./purge.js";

// `uninstall`: this environment's links and pairings in one command, sync torn down first while its credentials still
// exist. `--purge` is everything of the agent besides (purge.ts), what `ic uninstall` runs; `--delete-data` the person's
// data too, and implies --purge. The contract all of them keep with ic, the Windows uninstaller and the desktop app is
// ic uninstall's (one orchestrator), and this side of it is unchanged without a flag.

interface UninstallFlags {
    readonly purge: boolean;
    readonly deleteData: boolean;
}

export const uninstall = buildCommand<UninstallFlags>({
    docs: { brief: "Remove this environment's agent: every sandbox link, every sync pairing, the login entry (--purge: everything of it)" },
    parameters: {
        flags: {
            purge: {
                kind: "boolean",
                default: false,
                brief: "Everything of the agent too: keyring, PATH entry, Mutagen, WSL distros' agents, its files; your data (saved passwords, restore points, its record) stays",
            },
            deleteData: { kind: "boolean", default: false, brief: "With --purge (which it implies), delete your data too: saved passwords, restore points, its record" },
        },
    },
    async func(this: CommandContext, flags: UninstallFlags) {
        const ui = machineUi(this.process);
        const choice = purgeChoice(flags);
        ui.act(choice.deleteData ? "Removing the agent and your data from this device" : "Removing the agent from this device");
        if (choice.purge) {
            await purgeAgent(ui, choice.deleteData);
            return;
        }
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
