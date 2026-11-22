import type { IndexPair, PlanReading, PowerSettingKey, WindowsPowerReading } from "./windows-reading.js";
import { planRestore, planStayOn, type PowerSnapshot, type PowerWrite, snapshotWith, valueWords, writeLine } from "./writes.js";

/* WHAT `power stay-on` AND `power restore` WRITE, decided over a reading: mains power only, only the values that would
   stop work, nothing already as wanted, and a restore that never overwrites a value its owner changed since. */

const plan = (guid: string, name: string, settings: Partial<Record<PowerSettingKey, IndexPair>>, active = false): PlanReading => ({
    guid,
    name,
    active,
    settings: {
        standbyIdle: settings.standbyIdle ?? null,
        hibernateIdle: settings.hibernateIdle ?? null,
        lidAction: settings.lidAction ?? null,
        standbyConnectivity: settings.standbyConnectivity ?? null,
    },
});

const reading = (plans: readonly PlanReading[], rest: Partial<WindowsPowerReading> = {}): WindowsPowerReading => ({
    at: 0,
    plans,
    modernStandby: true,
    battery: true,
    lid: true,
    activeHours: { start: 8, end: 2 },
    utcOffsetMinutes: 60,
    ...rest,
});

const TURBO = "6fecc5ae-f350-48a5-b669-b472cb895ccf";
const BALANCED = "381b4222-f694-41f0-9685-ff5bb260df2e";

// rog's night: Turbo slept after 5 hours plugged in and cut the network in standby; Balanced hibernated after 3 hours.
const ROG_BEFORE = reading([
    plan(TURBO, "Turbo", { standbyIdle: { ac: 18_000, dc: 900 }, hibernateIdle: { ac: 0, dc: 0 }, lidAction: { ac: 1, dc: 1 }, standbyConnectivity: { ac: 0, dc: 0 } }, true),
    plan(BALANCED, "Balanced", { standbyIdle: { ac: 0, dc: 900 }, hibernateIdle: { ac: 10_800, dc: 0x7f_ff_ff_ff }, lidAction: { ac: 0, dc: 1 }, standbyConnectivity: { ac: 1, dc: 2 } }),
]);

test("stay-on writes each mains-power value that would stop work, plan by plan, and never a battery one", () => {
    expect(planStayOn(ROG_BEFORE)).toEqual([
        { plan: TURBO, planName: "Turbo", setting: "standbyIdle", from: 18_000, to: 0 },
        { plan: TURBO, planName: "Turbo", setting: "lidAction", from: 1, to: 0 },
        { plan: TURBO, planName: "Turbo", setting: "standbyConnectivity", from: 0, to: 1 },
        { plan: BALANCED, planName: "Balanced", setting: "hibernateIdle", from: 10_800, to: 0 },
    ]);
});

// Applied to the reading, the plan is what Windows then holds: asked again, there is nothing left to write.
const applied = (before: WindowsPowerReading, writes: readonly PowerWrite[]): WindowsPowerReading => ({
    ...before,
    plans: before.plans.map((entry) => {
        const after = (setting: PowerSettingKey): IndexPair | null => {
            const pair = entry.settings[setting];
            const write = writes.find((candidate) => candidate.plan === entry.guid && candidate.setting === setting);
            return pair === null || write === undefined ? pair : { ...pair, ac: write.to };
        };
        return { ...entry, settings: { standbyIdle: after("standbyIdle"), hibernateIdle: after("hibernateIdle"), lidAction: after("lidAction"), standbyConnectivity: after("standbyConnectivity") } };
    }),
});

test("a second stay-on writes nothing, and a value already as wanted is never written", () => {
    expect(planStayOn(applied(ROG_BEFORE, planStayOn(ROG_BEFORE)))).toEqual([]);
    // Managed by Windows (2) leaves the network up: not a value stay-on changes.
    expect(planStayOn(reading([plan(TURBO, "Turbo", { standbyConnectivity: { ac: 2, dc: 0 } })]))).toEqual([]);
    // 0xFFFFFFFF seconds is never already.
    expect(planStayOn(reading([plan(TURBO, "Turbo", { hibernateIdle: { ac: 0xff_ff_ff_ff, dc: 0 } })]))).toEqual([]);
});

test("the lid is left on a computer without one, and the network setting off Modern Standby, and an absent setting always", () => {
    const desktop = reading([plan(TURBO, "Turbo", { lidAction: { ac: 1, dc: 1 }, standbyConnectivity: { ac: 0, dc: 0 } })], { lid: false, modernStandby: false });
    expect(planStayOn(desktop)).toEqual([]);
    expect(planStayOn(reading([plan(TURBO, "Turbo", {})]))).toEqual([]);
});

test("the snapshot gains what a write is about to change, and an entry already saved keeps its original value", () => {
    const first = snapshotWith(undefined, planStayOn(ROG_BEFORE), 1000);
    expect(first).toEqual({
        at: 1000,
        entries: [
            { plan: TURBO, planName: "Turbo", setting: "standbyIdle", ac: 18_000, wrote: 0 },
            { plan: TURBO, planName: "Turbo", setting: "lidAction", ac: 1, wrote: 0 },
            { plan: TURBO, planName: "Turbo", setting: "standbyConnectivity", ac: 0, wrote: 1 },
            { plan: BALANCED, planName: "Balanced", setting: "hibernateIdle", ac: 10_800, wrote: 0 },
        ],
    });
    // The owner later set Turbo's sleep to an hour and Balanced's to 20 minutes; a second stay-on must not save its own
    // 0 or the owner's hour as Turbo's original, and does save Balanced's new value, which it had never touched.
    const second = snapshotWith(
        first,
        [
            { plan: TURBO, planName: "Turbo", setting: "standbyIdle", from: 3600, to: 0 },
            { plan: BALANCED, planName: "Balanced", setting: "standbyIdle", from: 1200, to: 0 },
        ],
        2000,
    );
    expect(second.at).toBe(1000);
    expect(second.entries.filter((entry) => entry.setting === "standbyIdle")).toEqual([
        { plan: TURBO, planName: "Turbo", setting: "standbyIdle", ac: 18_000, wrote: 0 },
        { plan: BALANCED, planName: "Balanced", setting: "standbyIdle", ac: 1200, wrote: 0 },
    ]);
});

test("restore writes back what still holds stay-on's value and leaves what its owner changed, a gone plan, and what is back", () => {
    const snapshot: PowerSnapshot = snapshotWith(undefined, planStayOn(ROG_BEFORE), 1000);
    const now = reading([
        plan(TURBO, "Turbo", { standbyIdle: { ac: 0, dc: 900 }, lidAction: { ac: 2, dc: 1 }, standbyConnectivity: { ac: 0, dc: 0 } }, true),
    ]);
    const restored = planRestore(snapshot, now);
    expect(restored.writes).toEqual([{ plan: TURBO, planName: "Turbo", setting: "standbyIdle", from: 0, to: 18_000 }]);
    expect(restored.left.map((left) => [left.entry.planName, left.entry.setting, left.why])).toEqual([
        ["Turbo", "lidAction", "it was changed since, to hibernates, which is kept"],
        ["Balanced", "hibernateIdle", "that power plan is gone"],
    ]);
    // Turbo's network setting reads 0 again, its value before: nothing to write and nothing to say.
    const missing = reading([plan(TURBO, "Turbo", {})]);
    expect(planRestore({ at: 1, entries: snapshot.entries.slice(0, 1) }, missing).left[0]?.why).toBe("that plan no longer has the setting");
});

test("a write reads as the plan, the setting on mains power and both values in words", () => {
    expect(writeLine({ plan: TURBO, planName: "Turbo", setting: "standbyIdle", from: 18_000, to: 0 })).toBe("Turbo: sleep after, on mains power, 5 hours → never");
    expect(writeLine({ plan: TURBO, planName: "Turbo", setting: "standbyConnectivity", from: 0, to: 1 })).toBe("Turbo: network in standby, on mains power, disabled → enabled");
    expect([valueWords("lidAction", 0), valueWords("lidAction", 3), valueWords("lidAction", 9), valueWords("hibernateIdle", 0x7f_ff_ff_ff)]).toEqual([
        "does nothing",
        "shuts down",
        "action 9",
        "never",
    ]);
});
