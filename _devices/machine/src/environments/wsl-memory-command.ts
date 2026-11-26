import { explain } from "@intentic/local-agent";
import { buildRouteMap, type CommandContext, numberParser } from "@stricli/core";
import { buildCommand, machineUi } from "../cli-ui.js";
import { thisSide } from "./wsl.js";
import { applyWslMemory, realWslconfigIo, wslconfigPath } from "./wslconfig-memory.js";

/* `intentic-machine wsl-memory apply --gb <N>` (2026-11-26): `memory=` in this PC's `.wslconfig` set to N GB, the file
   as it was kept beside it (wslconfig-memory.ts). The sandbox's `wsl-memory` op runs it detached at the owner's yes on
   its card (device/tools/agent.ts), with `--why` saying what the agent measured. Windows' own side only: the file is
   the Windows user's. Restarting WSL is left to the owner, since it restarts every sandbox on the PC. */

// Under this a sandbox cannot run at all; over it no PC this agent runs on has the memory.
const MIN_GB = 4;
const MAX_GB = 1024;

interface ApplyFlags {
    readonly gb: number;
    readonly why?: string;
}

const applyCommand = buildCommand<ApplyFlags>({
    docs: { brief: "Set memory= in this PC's .wslconfig, keeping the file as it was beside it (Windows; takes effect when WSL restarts)" },
    parameters: {
        flags: {
            gb: { kind: "parsed", parse: numberParser, brief: "The WSL VM's memory, in whole GB" },
            why: { kind: "parsed", parse: String, optional: true, brief: "Why, for the dated line the file gets beside the change" },
        },
    },
    async func(this: CommandContext, flags: ApplyFlags) {
        if ((await thisSide()) !== "windows") {
            throw new Error(explain("Nothing was changed.", ".wslconfig is the Windows user's file, and this is not Windows' own side.", "intentic-machine wsl-memory apply in PowerShell on this PC"));
        }
        if (!Number.isInteger(flags.gb) || flags.gb < MIN_GB || flags.gb > MAX_GB) {
            throw new Error(explain("Nothing was changed.", `--gb takes a whole number of GB from ${MIN_GB} to ${MAX_GB}, and ${flags.gb} is not one.`));
        }
        const ui = machineUi(this.process);
        const path = wslconfigPath();
        ui.act(`Setting memory=${flags.gb}GB in ${path}`);
        const change = await applyWslMemory(realWslconfigIo, { path, gb: flags.gb, why: flags.why ?? "set by hand with intentic-machine wsl-memory apply", now: Date.now() });
        if (!change.changed) {
            ui.done(`Nothing to change: ${path} already sets memory=${change.from ?? `${flags.gb}GB`}.`);
            return;
        }
        if (change.backupPath !== undefined) {
            ui.note(`Saved the file as it was to ${change.backupPath}.`);
        }
        ui.done(`Set memory=${flags.gb}GB in ${path}${change.from === undefined ? "" : `, from ${change.from}`}.`);
        ui.note("The WSL VM takes the new size only when WSL restarts, which restarts every sandbox on this PC.");
        ui.later([["restart WSL when nothing here needs to keep running", "wsl --shutdown"]]);
    },
});

export const wslMemoryRoutes = buildRouteMap({
    routes: { apply: applyCommand },
    docs: { brief: "The WSL VM's memory on this PC: set memory= in .wslconfig (Windows)" },
});
