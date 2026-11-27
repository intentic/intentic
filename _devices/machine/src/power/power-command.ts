import { plural } from "@intentic/base/format";
import { explain, type Footnote, type Item } from "@intentic/local-agent";
import { fixablePowerFindings, type HostPower, type HostPowerFinding, POWER_FINDING } from "@intentic/sandbox-contract/schemas/host-power";
import { buildRouteMap, type CommandContext } from "@stricli/core";
import { answeringUi, buildCommand, machineUi } from "../cli-ui.js";
import { handToWindows, windowsRoot } from "../environments/machine.js";
import { thisSide } from "../environments/wsl.js";
import { powerBeforePath, readPowerSnapshot, realPowerIo, restore, stayOn } from "./apply.js";
import { type PowerHere, readPowerHere } from "./host-power.js";
import { pauseUpdates, realPauseIo } from "./update-pause.js";
import { windowsFindings } from "./windows-findings.js";
import { readWindowsPower } from "./windows-reading.js";
import { hourWords } from "./words.js";
import { SETTING_WORDS, writeLine } from "./writes.js";

/* `intentic-machine power status | stay-on | restore | pause-updates` (2026-11-22): what this computer's own power
   settings would do to work left running on it, and on Windows, at the owner's word, the mains-power ones changed so it
   stays on (apply.ts), and put back, and (2026-11-27) Windows Update paused past work booked on it (update-pause.ts).
   The sandbox's `power-stay-on` and `update-pause` ops run `power stay-on` and `power pause-updates` detached
   (device/tools/agent.ts).
   In a WSL distro each verb is the Windows side's: its agent answers on this terminal, as `updates` does. */

const STAY_ON = "intentic-machine power stay-on";
const RESTORE = "intentic-machine power restore";

// A WSL distro's computer is the Windows PC around it: the Windows side's agent answers on this terminal. False
// anywhere else.
const handedToWindows = async (args: readonly string[]): Promise<boolean> => {
    if ((await thisSide()) !== "wsl") {
        return false;
    }
    const root = await windowsRoot();
    if (root === undefined) {
        throw new Error(
            explain(
                "This is a WSL distro, whose power settings are its Windows PC's.",
                "no agent was found on this PC's Windows side to ask.",
                `run intentic-machine power ${args.join(" ")} in PowerShell on this PC`,
            ),
        );
    }
    if (handToWindows(root, ["power", ...args]) !== 0) {
        process.exitCode = 1;
    }
    return true;
};

type ReadHere = Extract<PowerHere, { readonly power: HostPower }>;

// This computer's reading, or a stop where this environment does not read one.
const readHere = async (): Promise<ReadHere> => {
    const here = await readPowerHere();
    if ("power" in here) {
        return here;
    }
    throw new Error(
        here.kind === "wsl"
            ? explain("This is a WSL distro, whose power settings are its Windows PC's.", "the agent reads them on the Windows side.")
            : explain("This computer's power settings are not read here.", `the agent reads them on Windows, Linux and macOS, and this is ${here.platform}.`),
    );
};

const yesNo = (value: boolean | undefined): string => (value === undefined ? "could not be read" : value ? "yes" : "no");

// What the reading rests on, as a report's fields. Pure.
export const aboutFields = (here: ReadHere): Footnote[] => {
    switch (here.kind) {
        case "windows": {
            const { reading } = here;
            return [
                ["power plans", reading.plans.map((plan) => (plan.active ? `${plan.name} (active)` : plan.name)).join(", ") || "none listed"],
                ["battery", yesNo(reading.battery)],
                ["Modern Standby", yesNo(reading.modernStandby)],
                ["active hours", reading.activeHours === undefined ? "not set" : `${hourWords(reading.activeHours.start)} to ${hourWords(reading.activeHours.end)}`],
                ["updates paused", reading.pausedUntil === undefined || reading.pausedUntil <= reading.at ? "no" : `until ${new Date(reading.pausedUntil).toISOString()}`],
            ];
        }
        case "linux":
            return [
                ["sleep targets", here.reading.sleepTargets.join(", ") || "not answered"],
                ["lid", yesNo(here.reading.lid)],
            ];
        case "macos":
            return [["sleep on mains power", here.reading.acSleepMinutes === undefined ? "not listed" : here.reading.acSleepMinutes === 0 ? "never" : `${here.reading.acSleepMinutes} min`]];
    }
};

// One finding as a report's row: what stay-on would change is a warning, what it leaves is dim. Pure.
export const findingItem = (finding: HostPowerFinding): Item => ({ tone: finding.fixable ? "warn" : "skip", name: finding.id, meta: finding.text });

// The commands a reader of the status wants next. Pure.
export const statusLater = (power: HostPower, restorable: boolean): Footnote[] => [
    ...(fixablePowerFindings(power).length > 0 ? [["keep it on while plugged in", STAY_ON] as const] : []),
    ...power.findings.flatMap((finding) => (finding.command === undefined ? [] : [["stop it (needs root)", finding.command] as const])),
    ...(restorable ? [["put back what stay-on changed", RESTORE] as const] : []),
];

interface StatusFlags {
    readonly json: boolean;
}

const status = buildCommand<StatusFlags>({
    docs: { brief: "What this computer's own power settings would do to work left running on it: sleep, hibernate, the lid, update restarts" },
    parameters: {
        flags: { json: { kind: "boolean", brief: "Print one JSON object: the findings as this device's facts carry them", default: false } },
    },
    async func(this: CommandContext, flags: StatusFlags) {
        if (await handedToWindows(flags.json ? ["status", "--json"] : ["status"])) {
            return;
        }
        const ui = answeringUi(this.process, flags.json);
        const here = await readHere();
        // allow(silent-catch): an unreadable snapshot is one restore could not use either, so it reads as none
        const restorable = here.kind === "windows" && (await readPowerSnapshot().catch(() => undefined)) !== undefined;
        if (flags.json) {
            // allow(terminal-output): the --json document, HostPowerSchema's shape plus ok and restorable
            this.process.stdout.write(`${JSON.stringify({ ok: true, ...here.power, restorable })}\n`);
            return;
        }
        ui.report("intentic · power settings", "what this computer's own settings would do to work left running on it");
        ui.fields(aboutFields(here));
        if (here.power.findings.length === 0) {
            ui.quiet("Nothing in this computer's settings would put it to sleep or cut it off while work is left running.");
        } else {
            ui.section("what would stop work left running");
            ui.items(here.power.findings.map(findingItem));
        }
        const later = statusLater(here.power, restorable);
        if (later.length > 0) {
            ui.later(later);
        }
    },
});

// What each fixable finding says once stay-on has changed it.
const FIXED = new Map<string, string>([
    [POWER_FINDING.sleepIdle, "never sleeps by itself on mains power now"],
    [POWER_FINDING.hibernateIdle, "never hibernates by itself on mains power now"],
    [POWER_FINDING.lidClose, "closing the lid on mains power does nothing now"],
    [POWER_FINDING.standbyNetwork, "keeps the network in Modern Standby on mains power now"],
]);

// Each finding before stay-on, as what became of it. Pure.
export const outcomeItems = (before: HostPower, after: HostPower): Item[] =>
    before.findings.map((finding): Item => {
        const still = after.findings.find((candidate) => candidate.id === finding.id);
        // Not stay-on's to change: its own sentence, under the dim mark.
        if (!finding.fixable) {
            return { tone: "skip", name: finding.id, meta: finding.text };
        }
        return still === undefined ? { tone: "ok", name: finding.id, meta: FIXED.get(finding.id) ?? "changed" } : { tone: "fail", name: finding.id, meta: `still: ${still.text}` };
    });

const stayOnCommand = buildCommand({
    docs: { brief: "Change this computer's power settings so it stays on while plugged in (Windows; battery settings are left as they are)" },
    parameters: {},
    async func(this: CommandContext) {
        if (await handedToWindows(["stay-on"])) {
            return;
        }
        const ui = machineUi(this.process);
        if ((await thisSide()) !== "windows") {
            const here = await readHere();
            const commands = here.power.findings.filter((finding) => finding.command !== undefined);
            if (commands.length === 0) {
                ui.quiet("Nothing in this computer's settings would put it to sleep: nothing to change.");
                return;
            }
            throw new Error(
                explain(
                    "Nothing was changed.",
                    `${commands.map((finding) => finding.text).join(" ")} The agent does not change that here, since it needs root.`,
                    commands.map((finding) => finding.command).join("; "),
                ),
            );
        }
        ui.act("Keeping this computer on while plugged in");
        const outcome = await stayOn(realPowerIo, ui.note);
        const before = windowsFindings(outcome.before);
        const after = windowsFindings(outcome.after);
        const written = outcome.writes.length - outcome.failed.length;
        ui.done(
            outcome.writes.length === 0
                ? "Nothing to change: on mains power no power plan here sleeps, hibernates, acts on the lid or cuts the network."
                : `Changed ${plural(written, "setting")} in ${plural(new Set(outcome.writes.map((write) => write.plan)).size, "power plan")}, on mains power only; battery settings are as they were.`,
        );
        if (before.findings.length > 0) {
            ui.items(outcomeItems(before, after));
        }
        for (const failed of outcome.failed) {
            ui.warn(`${writeLine(failed.write)}: not written (${failed.why})`);
        }
        if (outcome.activateFailed !== undefined) {
            ui.warn(`The active plan did not reload its settings (${outcome.activateFailed}); it takes them the next time Windows loads it.`);
        }
        const remaining = fixablePowerFindings(after);
        if (remaining.length > 0) {
            throw new Error(explain("Not every setting was changed.", remaining.map((finding) => finding.text).join(" "), "intentic-machine power status"));
        }
        if (outcome.writes.length > 0) {
            ui.later([["put the old values back", RESTORE]]);
        }
    },
});

const restoreCommand = buildCommand({
    docs: { brief: "Put back the power settings `power stay-on` changed on this computer" },
    parameters: {},
    async func(this: CommandContext) {
        if (await handedToWindows(["restore"])) {
            return;
        }
        const ui = machineUi(this.process);
        if ((await thisSide()) !== "windows") {
            ui.quiet("Nothing to put back: stay-on changes power settings on Windows only.");
            return;
        }
        ui.act("Putting back the power settings stay-on changed");
        const outcome = await restore(realPowerIo, ui.note);
        if (outcome.kind === "nothing") {
            ui.done(`Nothing to put back: stay-on has not changed anything on this computer (there is no ${powerBeforePath}).`);
            return;
        }
        const written = outcome.plan.writes.length - outcome.failed.length;
        ui.done(written === 0 ? "Nothing needed writing back." : `Put back ${plural(written, "setting")} as they were before stay-on.`);
        if (outcome.plan.left.length > 0) {
            ui.items(outcome.plan.left.map((left) => ({ tone: "skip", name: `${left.entry.planName}: ${SETTING_WORDS[left.entry.setting]}`, meta: `left: ${left.why}` })));
        }
        for (const failed of outcome.failed) {
            ui.warn(`${writeLine(failed.write)}: not written (${failed.why})`);
        }
        if (outcome.kept) {
            throw new Error(explain("Not every setting was put back.", `the values that were not are still saved in ${powerBeforePath}.`, RESTORE));
        }
    },
});

// `--until` as epoch ms (what the sandbox's op sends) or anything Date.parse reads (what a person types). Pure.
const parseUntil = (value: string): number => {
    const at = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
    if (!Number.isFinite(at)) {
        throw new Error(`${value} is not a moment: give epoch milliseconds or a date such as 2026-11-28T08:00:00Z.`);
    }
    return at;
};

interface PauseFlags {
    readonly until: number;
}

const pauseCommand = buildCommand<PauseFlags>({
    docs: { brief: "Pause Windows Update until a moment (at most five weeks off), so it restarts nothing before then (Windows)" },
    parameters: {
        flags: { until: { kind: "parsed", parse: parseUntil, brief: "When the pause ends: epoch milliseconds, or a date such as 2026-11-28T08:00:00Z" } },
    },
    async func(this: CommandContext, flags: PauseFlags) {
        if (await handedToWindows(["pause-updates", "--until", String(flags.until)])) {
            return;
        }
        const ui = machineUi(this.process);
        if ((await thisSide()) !== "windows") {
            ui.quiet("Nothing to pause: this pauses Windows Update, and this is not Windows.");
            return;
        }
        ui.act(`Pausing Windows Update until ${new Date(flags.until).toISOString()}`);
        const outcome = await pauseUpdates(
            realPauseIo(async () => (await readWindowsPower()).pausedUntil),
            flags.until,
        );
        ui.done(
            outcome.kind === "already"
                ? `Windows Update was already paused until ${new Date(outcome.until).toISOString()}, which reaches past that: nothing was changed.`
                : `Windows Update is paused until ${new Date(outcome.until).toISOString()}: it restarts nothing before then. It resumes by itself after.`,
        );
        const after = await readWindowsPower();
        if (after.pausedUntil === undefined || after.pausedUntil < flags.until) {
            throw new Error(explain("Windows Update's pause does not read back.", "the values were written, but Windows reports no pause reaching that far.", "intentic-machine power status"));
        }
        if (after.restartPending === true) {
            ui.warn("An update is already installed and waiting for a restart: a pause may not hold that restart off. Restarting this PC yourself before you leave it does.");
        }
    },
});

export const powerRoutes = buildRouteMap({
    routes: { status, "stay-on": stayOnCommand, restore: restoreCommand, "pause-updates": pauseCommand },
    docs: { brief: "This computer's own power settings: whether it would sleep through work left running, and on Windows keeping it on while plugged in" },
});
