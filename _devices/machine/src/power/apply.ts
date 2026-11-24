import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { readTextIfExists, writeFileAtomic } from "@intentic/base/fs";
import { execBounded } from "@intentic/base/process";
import { explain } from "@intentic/local-agent";
import { baseDir } from "../config.js";
import { POWER_SETTINGS, type PowerSettingKey, readWindowsPower, type WindowsPowerReading } from "./windows-reading.js";
import { planRestore, planStayOn, type PowerSnapshot, PowerSnapshotSchema, type PowerWrite, type RestorePlan, snapshotWith, writeLine } from "./writes.js";

/* `power stay-on` AND `power restore` ON WINDOWS (2026-11-22): what writes.ts decided, done. Each value goes through
   `powercfg /setacvalueindex <plan> <subgroup> <setting> <value>`, which a signed-in user may run unelevated (checked
   on rog), and then `powercfg /setactive <the active plan>`, without which the active plan keeps running on what it
   had loaded. Before the first write the values as they were are saved to `~/.intentic/machine/power-before.json`, and
   a snapshot that cannot be read stops the run before anything is written: writing over it would lose the owner's
   own values for good. Each run reads the settings again afterwards, so what it reports is what Windows now holds,
   not what it meant to write. */

export const powerBeforePath = join(baseDir, "power-before.json");

// Touched after each run that wrote anything: the resident agent's kept reading is older than its time and is dropped
// (host-power.ts), so the device's facts say the new settings at once.
export const powerChangedPath = join(baseDir, "power-changed");

// What the two runs do to the computer, as seams for the tests.
export interface PowerIo {
    readonly read: () => Promise<WindowsPowerReading>;
    readonly readSnapshot: () => Promise<PowerSnapshot | undefined>;
    readonly saveSnapshot: (snapshot: PowerSnapshot) => Promise<void>;
    readonly dropSnapshot: () => Promise<void>;
    readonly write: (plan: string, setting: PowerSettingKey, value: number) => Promise<void>;
    readonly activate: (plan: string) => Promise<void>;
    // Touches the stamp the resident agent's reading is checked against.
    readonly changed: () => Promise<void>;
    readonly now: () => number;
}

// The snapshot, or undefined where there is none. Throws where one is there and cannot be read.
export const readPowerSnapshot = async (path = powerBeforePath): Promise<PowerSnapshot | undefined> => {
    const text = await readTextIfExists(path);
    if (text === undefined) {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        // allow(silent-catch): said as the stop below, which names the file
        parsed = undefined;
    }
    const snapshot = PowerSnapshotSchema.safeParse(parsed);
    if (!snapshot.success) {
        throw new Error(
            explain(
                "The power settings saved before an earlier stay-on cannot be read.",
                `${path} is not what stay-on writes, so nothing was changed: writing over it would lose the values it holds.`,
                `look at ${path}, then move it aside and run the same command again`,
            ),
        );
    }
    return snapshot.data;
};

const powercfg = async (args: readonly string[]): Promise<void> => {
    await execBounded("powercfg.exe", args, { timeoutMs: 15_000 });
};

export const realPowerIo: PowerIo = {
    read: () => readWindowsPower(),
    readSnapshot: () => readPowerSnapshot(),
    saveSnapshot: async (snapshot) => {
        await mkdir(baseDir, { recursive: true });
        await writeFileAtomic(powerBeforePath, `${JSON.stringify(snapshot, null, 2)}\n`);
    },
    dropSnapshot: async () => await rm(powerBeforePath, { force: true }),
    write: async (plan, setting, value) => await powercfg(["/setacvalueindex", plan, POWER_SETTINGS[setting].sub, POWER_SETTINGS[setting].setting, String(value)]),
    activate: async (plan) => await powercfg(["/setactive", plan]),
    changed: async () => {
        await mkdir(baseDir, { recursive: true });
        await writeFile(powerChangedPath, `${new Date().toISOString()}\n`);
    },
    now: Date.now,
};

export interface FailedWrite {
    readonly write: PowerWrite;
    readonly why: string;
}

export interface WritesDone {
    readonly failed: FailedWrite[];
    // Why `/setactive` failed, where it did: the values are saved, and the active plan takes them at its next load.
    readonly activateFailed: string | undefined;
}

// Writes each value, telling each as it lands, then has the active plan take them.
const writeAll = async (io: PowerIo, reading: WindowsPowerReading, writes: readonly PowerWrite[], say: (line: string) => void): Promise<WritesDone> => {
    const failed: FailedWrite[] = [];
    for (const write of writes) {
        try {
            // one at a time: powercfg writes the same store
            await io.write(write.plan, write.setting, write.to);
            say(writeLine(write));
        } catch (error) {
            failed.push({ write, why: errorMessage(error).split("\n")[0] ?? "powercfg failed" });
        }
    }
    const active = reading.plans.find((plan) => plan.active);
    let activateFailed: string | undefined;
    if (active !== undefined && failed.length < writes.length) {
        try {
            await io.activate(active.guid);
        } catch (error) {
            activateFailed = errorMessage(error).split("\n")[0] ?? "powercfg failed";
        }
    }
    if (failed.length < writes.length) {
        // A stamp that cannot be written costs only a stale reading for up to half an hour (POWER_REFRESH_MS): never a failed run.
        // allow(silent-catch): a missing stamp only leaves the resident's reading stale for up to half an hour (POWER_REFRESH_MS)
        await io.changed().catch(() => undefined);
    }
    return { failed, activateFailed };
};

export interface StayOnOutcome extends WritesDone {
    readonly before: WindowsPowerReading;
    readonly writes: readonly PowerWrite[];
    readonly after: WindowsPowerReading;
}

/** Stay-on: the snapshot first, then every write, then a fresh reading. */
export const stayOn = async (io: PowerIo, say: (line: string) => void): Promise<StayOnOutcome> => {
    const before = await io.read();
    const writes = planStayOn(before);
    if (writes.length === 0) {
        return { before, writes, after: before, failed: [], activateFailed: undefined };
    }
    const existing = await io.readSnapshot();
    const snapshot = snapshotWith(existing, writes, io.now());
    // Written only when it gains an entry, and then with every entry it had as it was.
    if (existing === undefined || snapshot.entries.length !== existing.entries.length) {
        await io.saveSnapshot(snapshot);
        say(`Saved the values before this change to ${powerBeforePath}.`);
    }
    const done = await writeAll(io, before, writes, say);
    return { before, writes, after: await io.read(), ...done };
};

export type RestoreOutcome =
    | { readonly kind: "nothing" }
    | (WritesDone & { readonly kind: "restored"; readonly plan: RestorePlan; readonly after: WindowsPowerReading; readonly kept: boolean });

/** Restore: every saved value the plan still holds stay-on's value for, written back; the snapshot dropped once all are. */
export const restore = async (io: PowerIo, say: (line: string) => void): Promise<RestoreOutcome> => {
    const snapshot = await io.readSnapshot();
    if (snapshot === undefined) {
        return { kind: "nothing" };
    }
    const reading = await io.read();
    const plan = planRestore(snapshot, reading);
    const done = await writeAll(io, reading, plan.writes, say);
    // Kept while a write failed, so the same command can finish the job; what was written back reads as back next time.
    const kept = done.failed.length > 0;
    if (!kept) {
        await io.dropSnapshot();
    }
    return { kind: "restored", plan, after: await io.read(), kept, ...done };
};
