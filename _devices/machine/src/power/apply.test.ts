import { type PowerIo, restore, stayOn } from "./apply.js";
import type { IndexPair, PlanReading, PowerSettingKey, WindowsPowerReading } from "./windows-reading.js";
import type { PowerSnapshot } from "./writes.js";

/* STAY-ON AND RESTORE AS THEY RUN, against a computer held in memory: the snapshot is saved before the first write and
   never loses an original, the active plan is reloaded, and restore drops the snapshot only once everything is back. */

const TURBO = "6fecc5ae-f350-48a5-b669-b472cb895ccf";
const SILENT = "64a64f24-65b9-4b56-befd-5ec1eaced9b3";

type Values = Record<string, Partial<Record<PowerSettingKey, IndexPair>>>;

// A computer: its plans' values, its snapshot, and every call made to it in order.
const computer = (values: Values, snapshot?: PowerSnapshot, failing: ReadonlySet<string> = new Set()) => {
    const calls: string[] = [];
    let saved = snapshot;
    const read = (): WindowsPowerReading => ({
        at: 0,
        plans: Object.entries(values).map(
            ([guid, settings]): PlanReading => ({
                guid,
                name: guid === TURBO ? "Turbo" : "Silent",
                active: guid === TURBO,
                settings: {
                    standbyIdle: settings.standbyIdle ?? null,
                    hibernateIdle: settings.hibernateIdle ?? null,
                    lidAction: settings.lidAction ?? null,
                    standbyConnectivity: settings.standbyConnectivity ?? null,
                },
            }),
        ),
        modernStandby: true,
        battery: true,
        lid: true,
        activeHours: undefined,
        utcOffsetMinutes: 0,
    });
    const io: PowerIo = {
        read: () => Promise.resolve(read()),
        readSnapshot: () => Promise.resolve(saved),
        saveSnapshot: (next) => {
            calls.push(`save ${next.entries.length}`);
            saved = next;
            return Promise.resolve();
        },
        dropSnapshot: () => {
            calls.push("drop");
            saved = undefined;
            return Promise.resolve();
        },
        write: (plan, setting, value) => {
            if (failing.has(`${plan} ${setting}`)) {
                return Promise.reject(new Error("Command failed: powercfg.exe (exit 1)"));
            }
            calls.push(`write ${plan === TURBO ? "Turbo" : "Silent"} ${setting} ${value}`);
            const pair = values[plan]?.[setting];
            if (pair !== undefined) {
                values[plan] = { ...values[plan], [setting]: { ...pair, ac: value } };
            }
            return Promise.resolve();
        },
        activate: (plan) => {
            calls.push(`activate ${plan === TURBO ? "Turbo" : "Silent"}`);
            return Promise.resolve();
        },
        changed: () => {
            calls.push("stamp");
            return Promise.resolve();
        },
        now: () => 1000,
    };
    return { io, calls, snapshot: () => saved, values };
};

test("stay-on saves the values before the first write, writes them, reloads the active plan, stamps the change and reads again", async () => {
    const pc = computer({ [TURBO]: { standbyIdle: { ac: 18_000, dc: 900 }, lidAction: { ac: 1, dc: 1 } }, [SILENT]: { hibernateIdle: { ac: 3600, dc: 3600 } } });
    const said: string[] = [];
    const outcome = await stayOn(pc.io, (line) => said.push(line));
    expect(pc.calls).toEqual(["save 3", "write Turbo standbyIdle 0", "write Turbo lidAction 0", "write Silent hibernateIdle 0", "activate Turbo", "stamp"]);
    expect(pc.snapshot()?.entries.map((entry) => [entry.setting, entry.ac])).toEqual([
        ["standbyIdle", 18_000],
        ["lidAction", 1],
        ["hibernateIdle", 3600],
    ]);
    expect(outcome.after.plans[0]?.settings.standbyIdle).toEqual({ ac: 0, dc: 900 });
    expect(outcome.failed).toEqual([]);
    expect(said).toContain("Turbo: sleep after, on mains power, 5 hours → never");
});

test("a second stay-on with nothing to write touches nothing, the snapshot included", async () => {
    const pc = computer({ [TURBO]: { standbyIdle: { ac: 0, dc: 900 } } }, { at: 1, entries: [{ plan: TURBO, planName: "Turbo", setting: "standbyIdle", ac: 18_000, wrote: 0 }] });
    const outcome = await stayOn(pc.io, () => undefined);
    expect(outcome.writes).toEqual([]);
    expect(pc.calls).toEqual([]);
    expect(pc.snapshot()?.entries[0]?.ac).toBe(18_000);
});

test("a stay-on after the owner changed a value again keeps the first original, and the restore writes that back", async () => {
    const first = { at: 1, entries: [{ plan: TURBO, planName: "Turbo", setting: "standbyIdle" as const, ac: 18_000, wrote: 0 }] };
    const pc = computer({ [TURBO]: { standbyIdle: { ac: 3600, dc: 900 } } }, first);
    await stayOn(pc.io, () => undefined);
    // Nothing new to save: the entry for that value is there, with the value from before the first stay-on.
    expect(pc.calls).toEqual(["write Turbo standbyIdle 0", "activate Turbo", "stamp"]);
    const restored = await restore(pc.io, () => undefined);
    expect(restored.kind).toBe("restored");
    expect(pc.values[TURBO]?.standbyIdle?.ac).toBe(18_000);
    expect(pc.snapshot()).toBeUndefined();
});

test("restore with no snapshot does nothing, and one with a failed write keeps the snapshot for the next run", async () => {
    expect(await restore(computer({ [TURBO]: {} }).io, () => undefined)).toEqual({ kind: "nothing" });
    const snapshot: PowerSnapshot = {
        at: 1,
        entries: [
            { plan: TURBO, planName: "Turbo", setting: "standbyIdle", ac: 18_000, wrote: 0 },
            { plan: TURBO, planName: "Turbo", setting: "lidAction", ac: 1, wrote: 0 },
        ],
    };
    const pc = computer({ [TURBO]: { standbyIdle: { ac: 0, dc: 0 }, lidAction: { ac: 0, dc: 0 } } }, snapshot, new Set([`${TURBO} lidAction`]));
    const outcome = await restore(pc.io, () => undefined);
    expect(outcome.kind === "restored" && outcome.kept).toBe(true);
    expect(outcome.kind === "restored" && outcome.failed.map((failed) => failed.write.setting)).toEqual(["lidAction"]);
    expect(pc.calls).toEqual(["write Turbo standbyIdle 18000", "activate Turbo", "stamp"]);
    expect(pc.snapshot()).toBe(snapshot);
});

test("a snapshot that cannot be read stops stay-on before anything is written", async () => {
    const pc = computer({ [TURBO]: { standbyIdle: { ac: 18_000, dc: 0 } } });
    const io: PowerIo = { ...pc.io, readSnapshot: () => Promise.reject(new Error("The power settings saved before an earlier stay-on cannot be read.")) };
    await expect(stayOn(io, () => undefined)).rejects.toThrow("cannot be read");
    expect(pc.calls).toEqual([]);
});

test("a run whose every write failed neither reloads the plan nor stamps a change", async () => {
    const pc = computer({ [TURBO]: { standbyIdle: { ac: 18_000, dc: 0 } } }, undefined, new Set([`${TURBO} standbyIdle`]));
    const outcome = await stayOn(pc.io, () => undefined);
    expect(outcome.failed.map((failed) => failed.why)).toEqual(["Command failed: powercfg.exe (exit 1)"]);
    expect(pc.calls).toEqual(["save 1"]);
});
