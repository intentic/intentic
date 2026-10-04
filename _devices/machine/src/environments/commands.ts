import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Log } from "@intentic/local-agent";
import { buildCommand, buildRouteMap, type CommandContext } from "@stricli/core";
import { ensureResident } from "../resident.js";
import { listDistros, WINDOWS_SIDE } from "../wsl.js";
import { heldDistros, type MachineConfig, readMachineConfig, runOnWindows, updateMachineConfig, windowsRoot, withChild } from "./machine.js";

// The commands that act on the PC as a whole rather than on this one environment of it.

const exec = promisify(execFile);

const attach = buildCommand<Record<never, never>, [string]>({
    docs: { brief: "Keep a WSL distro's agent running from this PC's Windows side (the distro's own agent asks for this)" },
    parameters: {
        positional: { kind: "tuple", parameters: [{ brief: "The distro, as `wsl -l` names it", parse: String, placeholder: "distro" }] },
    },
    async func(this: CommandContext, _flags: Record<never, never>, distro: string) {
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        if (!WINDOWS_SIDE) {
            throw new Error("only the Windows side of a PC keeps its distros running.");
        }
        const listed = await listDistros();
        if (listed === undefined) {
            throw new Error("wsl.exe could not be asked which distros this PC has.");
        }
        if (!listed.includes(distro)) {
            throw new Error(`WSL has no distro called "${distro}"; it lists ${listed.join(", ") || "none"}.`);
        }
        const before = await heldDistros();
        await updateMachineConfig((config) => withChild(config, distro));
        await ensureResident(out);
        out(before.includes(distro) ? `${distro} is already kept running from here.` : `${distro}'s agent is kept running from here now.`);
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
        // oxlint-disable-next-line eslint/no-await-in-loop -- one distro at a time; each is a wsl.exe round trip
        const has = await exec("wsl.exe", ["-d", distro, "--exec", "sh", "-c", HAS_RESIDENT_SH], { timeout: 30_000, windowsHide: true })
            .then(() => true)
            .catch(() => false);
        if (has) {
            // oxlint-disable-next-line eslint/no-await-in-loop -- ditto
            await updateMachineConfig((config) => withChild(config, distro));
            log(`${distro} runs an agent too: it is kept running from this side now.`);
        }
    }
};

const onOff = (value: string): "on" | "off" => {
    if (value === "on" || value === "off") {
        return value;
    }
    throw new Error(`"${value}" is not on or off.`);
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
        brief: "What this machine does by itself: update its agent (the whole PC at once), download each sandbox's next image, back each sandbox up daily and tidy what swaps leave behind",
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
                brief: "Back each sandbox up once a day, encrypted, on this machine (on by default)",
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
        const out = (message: string): void => void this.process.stdout.write(`${message}\n`);
        const root = await windowsRoot();
        if (root !== undefined) {
            if (runOnWindows(root, ["updates", ...updatesArgs(flags)], { inherit: true }).status !== 0) {
                throw new Error("the Windows side's agent did not take that; run it there: intentic-machine updates");
            }
            return;
        }
        if (updatesArgs(flags).length > 0) {
            await updateMachineConfig((config) => withSwitches(config, flags));
        }
        const config = await readMachineConfig();
        out(
            config.agentUpdates === false
                ? "Agent: updated only when asked (`intentic-machine upgrade`, or Update on the sandbox's Devices tab). Turn it back on with --agent on."
                : "Agent: updated by itself when a release is published, the whole PC at once. Turn it off with --agent off.",
        );
        out(
            config.sandboxUpdates === false
                ? "Sandboxes: each update downloads when you take it, a wait of minutes. Turn background downloads back on with --sandboxes on."
                : "Sandboxes: each one's next update is downloaded in the background, so applying it is a restart of about half a minute, which a sandbox takes by itself at a quiet moment unless its update card says otherwise. Turn the downloads off with --sandboxes off.",
        );
        out(
            config.sandboxBackups === false
                ? "Backups: none are taken by themselves. Turn the daily backup back on with --backups on."
                : "Backups: each running sandbox is backed up once a day, encrypted, on this machine (`intentic-machine sandbox backups <slug>` lists them). Turn it off with --backups off.",
        );
        out(
            config.sandboxTidy === false
                ? "Tidy: what swaps and removals leave behind stays until you run `ic sandbox tidy`. Turn the daily tidy back on with --tidy on."
                : "Tidy: once a day, images no sandbox can go back to, records of removed sandboxes and the trash past its week are cleared; volumes are only listed, never deleted. Turn it off with --tidy off.",
        );
    },
});
