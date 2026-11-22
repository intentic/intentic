import { type HostPower, type HostPowerFinding, POWER_FINDING } from "@intentic/sandbox-contract/schemas/host-power";
import { idleSeconds, type IndexPair, type PlanReading, type PowerSettingKey, type WindowsPowerReading } from "./windows-reading.js";
import { durationWords, hourWords, plansPhrase } from "./words.js";

/* WHAT A WINDOWS PC'S POWER SETTINGS WOULD DO TO WORK LEFT RUNNING ON IT (2026-11-22), as the contract's findings
   (host-power.ts): one per setting that would stop or delay a sandbox's scheduled work, each with the agent's own
   sentence for it. A value counts when ANY plan holds it, not only the active one: a vendor's own software (rog's
   ASUS one) switches plans by itself, so the plan active at noon is not always the one active at 05:37.

   Only what is on mains power is fixable: the owner's yes to `power-stay-on` changes those (apply.ts), and battery is
   reported and left alone, since a laptop in a bag must still sleep. Windows Update's restarts are reported too and
   never changed: the active hours are the owner's to pick, and a restart is still Windows'. */

// What one LIDACTION value does, as the contract's `action` and in a sentence.
interface LidAction {
    readonly action: string;
    readonly does: string;
    readonly verb: string;
}

const LID = new Map<number, LidAction>([
    [1, { action: "sleep", does: "puts it to sleep", verb: "sleeps" }],
    [2, { action: "hibernate", does: "hibernates it", verb: "hibernates" }],
    [3, { action: "shut-down", does: "shuts it down", verb: "shuts down" }],
]);

interface Holding {
    readonly plan: PlanReading;
    readonly value: number;
}

// The plans whose `key` makes `acts` true on that power source, with the value each holds; absent settings never act.
const holding = (reading: WindowsPowerReading, key: PowerSettingKey, source: keyof IndexPair, acts: (value: number) => boolean): Holding[] =>
    reading.plans.flatMap((plan) => {
        const pair = plan.settings[key];
        return pair !== null && acts(pair[source]) ? [{ plan, value: pair[source] }] : [];
    });

const names = (found: readonly Holding[]): string[] => found.map((entry) => entry.plan.name);

// "5 hours", or "30 minutes to 5 hours" where the plans differ.
const spanWords = (seconds: readonly number[]): string => {
    const least = Math.min(...seconds);
    const most = Math.max(...seconds);
    return least === most ? durationWords(least) : `${durationWords(least)} to ${durationWords(most)}`;
};

const idleFinding = (reading: WindowsPowerReading, key: "standbyIdle" | "hibernateIdle", id: string, verb: string): HostPowerFinding[] => {
    const found = holding(reading, key, "ac", (value) => idleSeconds(value) > 0);
    if (found.length === 0) {
        return [];
    }
    const seconds = found.map((entry) => idleSeconds(entry.value));
    return [
        {
            id,
            power: "ac",
            afterSeconds: Math.min(...seconds),
            plans: names(found),
            fixable: true,
            text: `${verb} after ${spanWords(seconds)} without input on mains power${plansPhrase(names(found))}.`,
        },
    ];
};

// A lid only where the computer has one, or where that could not be read: every plan carries LIDACTION, a desktop's too.
const lidFinding = (reading: WindowsPowerReading): HostPowerFinding[] => {
    const found = reading.lid === false ? [] : holding(reading, "lidAction", "ac", (value) => value !== 0);
    // The active plan's action is the one closing the lid does now; another plan's where the active one does nothing.
    const shown = found.find((entry) => entry.plan.active) ?? found[0];
    if (shown === undefined) {
        return [];
    }
    const lid = LID.get(shown.value);
    const finding: HostPowerFinding = {
        id: POWER_FINDING.lidClose,
        power: "ac",
        plans: names(found),
        fixable: true,
        text: `Closing the lid on mains power ${lid?.does ?? "stops it"}${plansPhrase(names(found))}.`,
    };
    if (lid !== undefined) {
        finding.action = lid.action;
    }
    return [finding];
};

// Modern Standby with the network off: the computer looks awake to a scheduler and every call out of it fails.
const standbyNetworkFinding = (reading: WindowsPowerReading): HostPowerFinding[] => {
    const found = reading.modernStandby === true ? holding(reading, "standbyConnectivity", "ac", (value) => value === 0) : [];
    return found.length === 0
        ? []
        : [
              {
                  id: POWER_FINDING.standbyNetwork,
                  power: "ac",
                  plans: names(found),
                  fixable: true,
                  text: `When the screen turns off on mains power, Modern Standby cuts the network${plansPhrase(names(found))}: whatever a sandbox calls out to fails until somebody wakes the computer.`,
              },
          ];
};

// Battery: told, never changed.
const batteryFinding = (reading: WindowsPowerReading): HostPowerFinding[] => {
    if (reading.battery !== true) {
        return [];
    }
    const sleeping = holding(reading, "standbyIdle", "dc", (value) => idleSeconds(value) > 0);
    const lidded = reading.lid === false ? [] : holding(reading, "lidAction", "dc", (value) => value !== 0);
    if (sleeping.length === 0 && lidded.length === 0) {
        return [];
    }
    const seconds = sleeping.map((entry) => idleSeconds(entry.value));
    const lidShown = lidded.find((entry) => entry.plan.active) ?? lidded[0];
    const parts = [
        ...(seconds.length === 0 ? [] : [`sleeps after ${spanWords(seconds)} without input`]),
        ...(lidShown === undefined ? [] : [`${LID.get(lidShown.value)?.verb ?? "stops"} when the lid closes`]),
    ];
    const plans = [...new Set([...names(sleeping), ...names(lidded)])];
    const finding: HostPowerFinding = {
        id: POWER_FINDING.batterySleep,
        power: "dc",
        plans,
        fixable: false,
        text: `On battery it ${parts.join(" and ")}${plansPhrase(plans)}; that is left as it is, so a laptop in a bag still sleeps.`,
    };
    if (seconds.length > 0) {
        finding.afterSeconds = Math.min(...seconds);
    }
    return [finding];
};

// Windows Update restarts outside the active hours: from where they end to where they start.
const updateRestartFinding = (reading: WindowsPowerReading): HostPowerFinding[] => {
    const hours = reading.activeHours;
    return hours === undefined
        ? []
        : [
              {
                  id: POWER_FINDING.updateRestart,
                  window: { fromHour: hours.end, toHour: hours.start },
                  fixable: false,
                  text: `Windows Update may restart it between ${hourWords(hours.end)} and ${hourWords(hours.start)} local time, outside its active hours; after a restart nothing runs again until somebody signs in, since the agent and Docker Desktop start at sign-in.`,
              },
          ];
};

/** What a Windows reading says, as the device's facts carry it. Pure. */
export const windowsFindings = (reading: WindowsPowerReading): HostPower => {
    const power: HostPower = {
        at: reading.at,
        utcOffsetMinutes: reading.utcOffsetMinutes,
        findings: [
            ...idleFinding(reading, "standbyIdle", POWER_FINDING.sleepIdle, "Sleeps"),
            ...idleFinding(reading, "hibernateIdle", POWER_FINDING.hibernateIdle, "Hibernates"),
            ...lidFinding(reading),
            ...standbyNetworkFinding(reading),
            ...batteryFinding(reading),
            ...updateRestartFinding(reading),
        ],
    };
    if (reading.battery !== undefined) {
        power.battery = reading.battery;
    }
    return power;
};
