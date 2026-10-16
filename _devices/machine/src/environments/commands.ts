import { execBounded } from "@intentic/base/process";
import { explain, type Footnote, type Item, type Log } from "@intentic/local-agent";
import { buildRouteMap, type CommandContext } from "@stricli/core";
import { buildCommand, machineUi } from "../cli-ui.js";
import { ensureResident } from "../resident/resident.js";
import { listDistros, WINDOWS_SIDE } from "./wsl.js";
import { handToWindows, heldDistros, type MachineConfig, readMachineConfig, updateMachineConfig, windowsRoot, withChild } from "./machine.js";

// The commands that act on the PC as a whole rather than on this one environment of it.

const attach = buildCommand<Record<never, never>, [string]>({
    docs: { brief: "Keep a WSL distro's agent running from this PC's Windows side (the distro's own agent asks for this)" },
    parameters: {
        positional: { kind: "tuple", parameters: [{ brief: "The distro, as `wsl -l` names it", parse: String, placeholder: "distro" }] },
    },
    async func(this: CommandContext, _flags: Record<never, never>, distro: string) {
        const ui = machineUi(this.process);
        const failed = `${distro} is not kept running from here.`;
        if (!WINDOWS_SIDE) {
            throw new Error(explain(failed, "only the Windows side of a device keeps its WSL distros running."));
        }
        ui.act(`Keeping ${distro} running from this side`);
        const listed = await listDistros();
        if (listed === undefined) {
            throw new Error(explain(failed, "wsl.exe could not be asked which distros this device has."));
        }
        if (!listed.includes(distro)) {
            throw new Error(explain(failed, `WSL has no distro called ${distro}; it lists ${listed.join(", ") || "none"}.`));
        }
        const before = await heldDistros();
        await updateMachineConfig((config) => withChild(config, distro));
        await ensureResident(ui.note);
        ui.done(before.includes(distro) ? `${distro} is already kept running from here.` : `${distro}'s agent is kept running from here now.`);
    },
});

export const environmentRoutes = buildRouteMap({
    routes: { attach },
    docs: { brief: "How the environments of this PC (Windows and its WSL distros) run as one machine" },
});

// A distro running an agent is one the Windows side should hold up; its pidfile is the proof, read without booting it.
const HAS_RESIDENT_SH = `[ -x "$HOME/.intentic/machine/bin/intentic-machine" ] && [ -s "$HOME/.intentic/machine/machine.pid" ]`;

// Run by a Windows setup: distros whose agents started before this side existed are taken over, not left unsupervised.
export const adoptRunningDistros = async (log: Log): Promise<void> => {
    if (!WINDOWS_SIDE) {
        return;
    }
    const held = await heldDistros();
    const running = ((await listDistros({ running: true })) ?? []).filter((distro) => !held.includes(distro));
    for (const distro of running) {
        // one distro at a time; each is a wsl.exe round trip
        const has = await execBounded("wsl.exe", ["-d", distro, "--exec", "sh", "-c", HAS_RESIDENT_SH], { timeoutMs: 30_000 })
            .then(() => true)
            .catch(() => false);
        if (has) {
            // ditto
            await updateMachineConfig((config) => withChild(config, distro));
            log(`${distro} runs an agent too: it is kept running from this side now.`);
        }
    }
};

const onOff = (value: string): "on" | "off" => {
    if (value === "on" || value === "off") {
        return value;
    }
    throw new Error(`${value} is not on or off.`);
};

export interface UpdatesFlags {
    readonly agent?: "on" | "off";
    readonly sandboxes?: "on" | "off";
    readonly backups?: "on" | "off";
    readonly tidy?: "on" | "off";
}

// On is the resting state and is stored as the key's absence; only an explicit off is written down.
const switchedTo = (flag: "on" | "off" | undefined, stored: boolean | undefined): boolean | undefined =>
    flag === undefined ? stored : flag === "on" ? undefined : false;

// The config with its switches set as asked, every other key as it was.
type SwitchedConfig = { -readonly [K in keyof MachineConfig]: MachineConfig[K] };

export const withSwitches = (config: MachineConfig, flags: UpdatesFlags): MachineConfig => {
    const { agentUpdates, sandboxUpdates, sandboxBackups, sandboxTidy, ...rest } = config;
    const next: SwitchedConfig = rest;
    const agent = switchedTo(flags.agent, agentUpdates);
    const sandboxes = switchedTo(flags.sandboxes, sandboxUpdates);
    const backups = switchedTo(flags.backups, sandboxBackups);
    const tidy = switchedTo(flags.tidy, sandboxTidy);
    if (agent !== undefined) {
        next.agentUpdates = agent;
    }
    if (sandboxes !== undefined) {
        next.sandboxUpdates = sandboxes;
    }
    if (backups !== undefined) {
        next.sandboxBackups = backups;
    }
    if (tidy !== undefined) {
        next.sandboxTidy = tidy;
    }
    return next;
};

const updatesArgs = (flags: UpdatesFlags): string[] =>
    (["agent", "sandboxes", "backups", "tidy"] as const).flatMap((flag) => {
        const value = flags[flag];
        return value === undefined ? [] : [`--${flag}`, value];
    });

// Every switch is the PC's, kept on its root: a distro hands the command to its Windows side rather than keeping a copy.
export const updates = buildCommand<UpdatesFlags>({
    docs: {
        brief: "What this device does by itself: update its agent (the whole PC at once), download each sandbox's next image, back each sandbox up daily and tidy what swaps leave behind",
    },
    parameters: {
        flags: {
            agent: { kind: "parsed", parse: onOff, optional: true, brief: "Update the agent on this PC by itself when a release is published (on by default)" },
            sandboxes: {
                kind: "parsed",
                parse: onOff,
                optional: true,
                brief: "Download each sandbox's next update in the background, so applying it is a short restart (on by default)",
            },
            backups: {
                kind: "parsed",
                parse: onOff,
                optional: true,
                brief: "Back each sandbox up once a day, encrypted, on this device (on by default)",
            },
            tidy: {
                kind: "parsed",
                parse: onOff,
                optional: true,
                brief: "Once a day, clear the images, records and trash that swaps and removals leave behind; volumes are never deleted (on by default)",
            },
        },
    },
    async func(this: CommandContext, flags: UpdatesFlags) {
        const root = await windowsRoot();
        if (root !== undefined) {
            // The Windows side draws its own answer, and its own stop, on this terminal.
            if (handToWindows(root, ["updates", ...updatesArgs(flags)]) !== 0) {
                process.exitCode = 1;
            }
            return;
        }
        const ui = machineUi(this.process);
        if (updatesArgs(flags).length > 0) {
            ui.act("Changing what this device does by itself");
            await updateMachineConfig((config) => withSwitches(config, flags));
            ui.done("Saved. Each switch applies from the agent's next pass.");
        }
        const config = await readMachineConfig();
        ui.report("intentic · what this device does by itself");
        const rows = switchRows(config);
        ui.items(rows.map((row) => row.item));
        ui.later(rows.map((row) => row.later));
    },
});

// One switch of `updates`: its row, and the command that flips it.
interface SwitchRow {
    readonly item: Item;
    readonly later: Footnote;
}

const switchRow = (name: keyof UpdatesFlags, on: boolean, saidOn: string, saidOff: string): SwitchRow => ({
    item: { tone: on ? "ok" : "skip", name, meta: on ? saidOn : saidOff },
    later: [`turn ${name} ${on ? "off" : "on"}`, `intentic-machine updates --${name} ${on ? "off" : "on"}`],
});

// Every switch, in the words of what it does while on and what happens instead while off. Pure.
export const switchRows = (config: MachineConfig): readonly SwitchRow[] => [
    switchRow("agent", config.agentUpdates !== false, "updated by itself, the whole device at once", "updated only when asked"),
    switchRow("sandboxes", config.sandboxUpdates !== false, "each next update downloads in the background", "each update downloads when it is taken"),
    switchRow("backups", config.sandboxBackups !== false, "each running sandbox daily, encrypted, on this device", "none taken by themselves"),
    switchRow("tidy", config.sandboxTidy !== false, "daily: old images, removed sandboxes' records, week-old trash", "left until tidied by hand"),
];
