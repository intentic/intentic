import { execBounded } from "@intentic/base/process";
import { type HostPower, type HostPowerFinding, POWER_FINDING } from "@intentic/sandbox-contract/schemas/host-power";
import { durationWords } from "./words.js";

/* WHAT A MAC WOULD DO TO WORK LEFT RUNNING ON IT (2026-11-22): `pmset -g custom` lists each power source's settings
   under its own heading ("Battery Power:", "AC Power:"), and the AC section's `sleep` is the minutes without input
   after which the Mac sleeps on mains power, 0 for never. Changing it needs root, so the finding carries the command
   and the agent never runs it. A MacBook also sleeps when its lid closes, whatever `sleep` says, unless an external
   display is attached; no setting changes that, so it is only said. */

const PMSET_COMMAND = "sudo pmset -c sleep 0";

export interface MacPowerReading {
    readonly at: number;
    readonly utcOffsetMinutes: number;
    // Undefined where the AC section has no `sleep` line.
    readonly acSleepMinutes: number | undefined;
    // A battery section: a MacBook.
    readonly battery: boolean;
}

// `pmset -g custom` as the AC section's sleep and whether there is a battery section. Pure.
export const pmsetFrom = (stdout: string): Pick<MacPowerReading, "acSleepMinutes" | "battery"> => {
    let section = "";
    let battery = false;
    let acSleepMinutes: number | undefined;
    for (const line of stdout.split(/\r?\n/)) {
        const heading = /^(\S.*?)\s*:\s*$/.exec(line)?.[1];
        if (heading !== undefined) {
            section = heading.toLowerCase();
            battery ||= section.startsWith("battery");
            continue;
        }
        const sleep = /^\s+sleep\s+(\d+)/.exec(line)?.[1];
        if (section.startsWith("ac") && sleep !== undefined) {
            acSleepMinutes = Number(sleep);
        }
    }
    return { acSleepMinutes, battery };
};

/** What a macOS reading says, as the device's facts carry it. Pure. */
export const macFindings = (reading: MacPowerReading): HostPower => {
    const findings: HostPowerFinding[] = [];
    const minutes = reading.acSleepMinutes ?? 0;
    if (minutes > 0) {
        const lid = reading.battery ? " Closing the lid sleeps a Mac whatever this says, unless an external display is attached." : "";
        findings.push({
            id: POWER_FINDING.osSleep,
            power: "ac",
            afterSeconds: minutes * 60,
            fixable: false,
            command: PMSET_COMMAND,
            text: `Sleeps after ${durationWords(minutes * 60)} without input on mains power (pmset's AC sleep).${lid}`,
        });
    }
    return { at: reading.at, utcOffsetMinutes: reading.utcOffsetMinutes, battery: reading.battery, findings };
};

export const readMacPower = async (now: () => number = Date.now): Promise<MacPowerReading> => {
    const { stdout } = await execBounded("pmset", ["-g", "custom"], { timeoutMs: 10_000 });
    return { at: now(), utcOffsetMinutes: -new Date(now()).getTimezoneOffset(), ...pmsetFrom(stdout) };
};
