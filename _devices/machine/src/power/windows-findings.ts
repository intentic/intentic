import type { BeforeSignInState } from "@intentic/local-agent";
import { type HostPower, type HostPowerFinding, POWER_FINDING, POWER_REMEDY } from "@intentic/sandbox-contract/schemas/host-power";
import { idleSeconds, type IndexPair, type PlanReading, type PowerSettingKey, type WindowsPowerReading } from "./windows-reading.js";
import { durationWords, hourWords, plansPhrase } from "./words.js";

/* WHAT A WINDOWS PC'S POWER SETTINGS WOULD DO TO WORK LEFT RUNNING ON IT (2026-11-22), as the contract's findings
   (host-power.ts): one per setting that would stop or delay a sandbox's scheduled work, each with the agent's own
   sentence for it. A value counts when ANY plan holds it, not only the active one: a vendor's own software (rog's
   ASUS one) switches plans by itself, so the plan active at noon is not always the one active at 05:37.

   Only what is on mains power is fixable: the owner's yes to `power-stay-on` changes those (apply.ts), and battery is
   reported and left alone, since a laptop in a bag must still sleep. Windows Update's restarts are never changed by
   stay-on (the active hours are the owner's to pick, and a restart is still Windows'); since 2026-11-27 their finding
   says what answers them (host-power.ts POWER_REMEDY): a pause until after the booked work, and, where the sandboxes run
   on intentic's engine, the boot task that brings them back before anyone signs in. */

/** What decides whether a restart stops this PC's sandboxes for the night: the boot task, and the engine they run on. */
export interface RestartReading {
    // Windows' start before sign-in (local-agent's beforeSignIn); undefined where this install has none to offer.
    readonly beforeSignIn: BeforeSignInState | undefined;
    // Whether the sandboxes here run on intentic's engine, which the agent starts with no session; Docker Desktop is a
    // program with a window and waits for a sign-in.
    readonly ownEngine: boolean;
}

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

// What brings the sandboxes back after a restart, said as the end of the finding's sentence. Pure.
const afterRestartWords = (comesBack: "sign-in" | "boot", restart: RestartReading | undefined): string => {
    if (comesBack === "boot") {
        return "after a restart the agent starts with the PC, before anyone signs in, and starts intentic's engine and the sandboxes on it again.";
    }
    if (restart?.ownEngine === true) {
        return restart.beforeSignIn === "stale"
            ? "after a restart nothing runs again until somebody signs in: the start before sign-in that Windows holds is an older install's, which may start an agent that is no longer here."
            : "after a restart nothing runs again until somebody signs in, since the agent starts at sign-in; starting it before sign-in brings intentic's engine and the sandboxes back by themselves.";
    }
    return "after a restart nothing runs again until somebody signs in, since the agent and Docker Desktop start at sign-in.";
};

// Windows Update restarts outside the active hours: from where they end to where they start. Paused, it restarts nothing
// until the pause ends, which the finding carries for the daemon to weigh against the booked work.
const updateRestartFinding = (reading: WindowsPowerReading, restart: RestartReading | undefined): HostPowerFinding[] => {
    const hours = reading.activeHours;
    if (hours === undefined) {
        return [];
    }
    const comesBack = restart?.ownEngine === true && restart.beforeSignIn === "on" ? "boot" : "sign-in";
    const offers = [
        POWER_REMEDY.pauseUpdates,
        ...(restart?.ownEngine === true && restart.beforeSignIn !== undefined && restart.beforeSignIn !== "on" ? [POWER_REMEDY.beforeSignIn] : []),
    ];
    const paused = reading.pausedUntil !== undefined && reading.pausedUntil > reading.at ? reading.pausedUntil : undefined;
    const finding: HostPowerFinding = {
        id: POWER_FINDING.updateRestart,
        window: { fromHour: hours.end, toHour: hours.start },
        fixable: false,
        offers,
        comesBack,
        text: `Windows Update may restart it between ${hourWords(hours.end)} and ${hourWords(hours.start)} local time, outside its active hours${paused === undefined ? "" : `, once its pause ends at ${new Date(paused).toISOString()}`}; ${afterRestartWords(comesBack, restart)}`,
    };
    if (paused !== undefined) {
        finding.pausedUntil = paused;
    }
    if (reading.restartPending === true) {
        finding.restartPending = true;
    }
    return [finding];
};

/** What a Windows reading says, as the device's facts carry it. Pure. */
export const windowsFindings = (reading: WindowsPowerReading, restart?: RestartReading): HostPower => {
    const power: HostPower = {
        at: reading.at,
        utcOffsetMinutes: reading.utcOffsetMinutes,
        findings: [
            ...idleFinding(reading, "standbyIdle", POWER_FINDING.sleepIdle, "Sleeps"),
            ...idleFinding(reading, "hibernateIdle", POWER_FINDING.hibernateIdle, "Hibernates"),
            ...lidFinding(reading),
            ...standbyNetworkFinding(reading),
            ...batteryFinding(reading),
            ...updateRestartFinding(reading, restart),
        ],
    };
    if (reading.battery !== undefined) {
        power.battery = reading.battery;
    }
    return power;
};
