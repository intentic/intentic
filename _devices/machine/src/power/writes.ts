import { z } from "zod";
import { durationWords } from "./words.js";
import { idleSeconds, type PlanReading, POWER_SETTING_KEYS, type PowerSettingKey, type WindowsPowerReading } from "./windows-reading.js";

/* WHAT `power stay-on` WRITES, AND WHAT `power restore` WRITES BACK (2026-11-22), decided here and nowhere else: pure
   over a reading, so every rule is pinned without a computer. Stay-on changes each plan on mains power only, and
   only the values that would stop work left running: sleep after and hibernate after to never, the lid to do nothing
   (on a computer with a lid), and on Modern Standby the network in standby from disabled to enabled. A value already
   as wanted is not written, so a second stay-on writes nothing. Battery values are never written.

   The values as they were are saved before the first write (apply.ts) and never lost: an entry already saved keeps
   its value, since after the first stay-on the plan holds stay-on's own value, not the owner's. Restore writes an
   entry back only where the plan still holds what stay-on wrote; one the owner has changed since is theirs and is left. */

// One value written: a plan's setting on mains power, from what it holds to what it is set to.
export interface PowerWrite {
    readonly plan: string;
    readonly planName: string;
    readonly setting: PowerSettingKey;
    readonly from: number;
    readonly to: number;
}

// What stay-on sets one setting of one plan to, or undefined where it is left as it is.
const stayOnValue = (reading: WindowsPowerReading, plan: PlanReading, key: PowerSettingKey): number | undefined => {
    const pair = plan.settings[key];
    if (pair === null) {
        return undefined;
    }
    switch (key) {
        case "standbyIdle":
        case "hibernateIdle":
            return idleSeconds(pair.ac) > 0 ? 0 : undefined;
        case "lidAction":
            return reading.lid !== false && pair.ac !== 0 ? 0 : undefined;
        case "standbyConnectivity":
            return reading.modernStandby === true && pair.ac === 0 ? 1 : undefined;
    }
};

/** Every value stay-on writes, plan by plan in the reading's order. Pure. */
export const planStayOn = (reading: WindowsPowerReading): PowerWrite[] =>
    reading.plans.flatMap((plan) =>
        POWER_SETTING_KEYS.flatMap((setting) => {
            const to = stayOnValue(reading, plan, setting);
            const from = plan.settings[setting]?.ac;
            return to === undefined || from === undefined || from === to ? [] : [{ plan: plan.guid, planName: plan.name, setting, from, to }];
        }),
    );

const SnapshotEntrySchema = z.object({
    plan: z.string(),
    planName: z.string(),
    setting: z.enum(POWER_SETTING_KEYS),
    // The value on mains power before stay-on, and what stay-on wrote over it.
    ac: z.number().int().nonnegative(),
    wrote: z.number().int().nonnegative(),
});
export type PowerSnapshotEntry = z.infer<typeof SnapshotEntrySchema>;

// `~/.intentic/machine/power-before.json`.
export const PowerSnapshotSchema = z.object({
    at: z.number().describe("When the first value was saved, in epoch ms."),
    entries: z.array(SnapshotEntrySchema),
});
export type PowerSnapshot = z.infer<typeof PowerSnapshotSchema>;

/** The snapshot with every value `writes` is about to change, an entry already saved kept as it is. Pure. */
export const snapshotWith = (existing: PowerSnapshot | undefined, writes: readonly PowerWrite[], at: number): PowerSnapshot => {
    const entries = [...(existing?.entries ?? [])];
    for (const write of writes) {
        if (!entries.some((entry) => entry.plan === write.plan && entry.setting === write.setting)) {
            entries.push({ plan: write.plan, planName: write.planName, setting: write.setting, ac: write.from, wrote: write.to });
        }
    }
    return { at: existing?.at ?? at, entries };
};

// A saved value restore does not write, and why.
export interface LeftEntry {
    readonly entry: PowerSnapshotEntry;
    readonly why: string;
}

export interface RestorePlan {
    readonly writes: PowerWrite[];
    readonly left: LeftEntry[];
}

/** What restore writes back, and what it leaves. Pure. */
export const planRestore = (snapshot: PowerSnapshot, reading: WindowsPowerReading): RestorePlan => {
    const writes: PowerWrite[] = [];
    const left: LeftEntry[] = [];
    for (const entry of snapshot.entries) {
        const plan = reading.plans.find((candidate) => candidate.guid === entry.plan);
        const now = plan?.settings[entry.setting]?.ac;
        if (plan === undefined) {
            left.push({ entry, why: "that power plan is gone" });
        } else if (now === undefined) {
            left.push({ entry, why: "that plan no longer has the setting" });
        } else if (now === entry.ac) {
            // Already back where it was: nothing to write, nothing to say.
        } else if (now === entry.wrote) {
            writes.push({ plan: plan.guid, planName: plan.name, setting: entry.setting, from: now, to: entry.ac });
        } else {
            left.push({ entry, why: `it was changed since, to ${valueWords(entry.setting, now)}, which is kept` });
        }
    }
    return { writes, left };
};

// ---- Words for a person reading what was written.

export const SETTING_WORDS = {
    standbyIdle: "sleep after",
    hibernateIdle: "hibernate after",
    lidAction: "closing the lid",
    standbyConnectivity: "network in standby",
} as const satisfies Readonly<Record<PowerSettingKey, string>>;

const LID_WORDS = ["does nothing", "sleeps", "hibernates", "shuts down"];
const CONNECTIVITY_WORDS = ["disabled", "enabled", "managed by Windows"];

// One value of a setting as a person says it. Pure.
export const valueWords = (setting: PowerSettingKey, value: number): string => {
    switch (setting) {
        case "standbyIdle":
        case "hibernateIdle":
            return idleSeconds(value) === 0 ? "never" : durationWords(value);
        case "lidAction":
            return LID_WORDS[value] ?? `action ${value}`;
        case "standbyConnectivity":
            return CONNECTIVITY_WORDS[value] ?? `value ${value}`;
    }
};

// "Turbo: sleep after, on mains power, 5 hours → never". Pure.
export const writeLine = (write: PowerWrite): string =>
    `${write.planName}: ${SETTING_WORDS[write.setting]}, on mains power, ${valueWords(write.setting, write.from)} → ${valueWords(write.setting, write.to)}`;
