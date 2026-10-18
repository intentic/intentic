import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { testConfig } from "../../env.config.testing.js";
import { createHostedSleep } from "./hosted-sleep.js";

const logger = pino({ level: "silent" });

let root = "";
beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "hosted-sleep-"));
});
afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

const sleepOf = (save: (at: number | null, personAt: number) => Promise<boolean>) => createHostedSleep({ ...testConfig, historyRoot: root }, logger, save);

test("until the boot takes charge, the last sleep's alarm stands whatever idle-stop asks", async () => {
    const save = jest.fn(async () => true);
    const sleep = sleepOf(save);
    expect(await sleep.prepare(9_000_000, 0)).toBe(true);
    expect(await sleep.cancel(0)).toBe(true);
    expect(save).not.toHaveBeenCalled();
});

test("taking charge retracts the old alarm before a new preparation can replace it", async () => {
    const boot = Promise.withResolvers<boolean>();
    const calls: (number | null)[] = [];
    const sleep = sleepOf(async (at) => {
        calls.push(at);
        return at === null ? boot.promise : true;
    });
    const retracted = sleep.retractAtBoot();
    const first = sleep.prepare(9_000_000, 0);
    const second = sleep.prepare(3_000_000, 0);
    await Promise.resolve();
    expect(calls).toEqual([null]);
    boot.resolve(true);
    expect(await retracted).toBe(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(calls).toEqual([null, 9_000_000, 3_000_000]);
});

test("an unacknowledged or failed write forbids sleep and the next attempt can recover", async () => {
    const save = jest.fn(async (at: number | null) => {
        if (at === 1) {
            return false;
        }
        if (at === 2) {
            throw new Error("platform unreachable");
        }
        return true;
    });
    const sleep = sleepOf(save);
    await sleep.retractAtBoot();
    expect(await sleep.prepare(1, 0)).toBe(false);
    expect(await sleep.prepare(2, 0)).toBe(false);
    expect(await sleep.prepare(3, 0)).toBe(true);
    expect(save.mock.calls.map(([at]) => at)).toEqual([null, 1, 2, 3]);
});

test("a sleep with no promises retracts the alarm, and says when a person was last here", async () => {
    const save = jest.fn(async (_at: number | null, _personAt: number) => true);
    const sleep = sleepOf(save);
    await sleep.retractAtBoot();
    expect(await sleep.prepare(9_000_000, 1_000)).toBe(true);
    expect(await sleep.prepare(0, 2_000)).toBe(true);
    expect(save.mock.calls).toEqual([[null, 0], [9_000_000, 1_000], [null, 2_000]]);
});

test("a rejected final sleep check retracts after its in-flight registration", async () => {
    const saved = Promise.withResolvers<boolean>();
    const calls: (number | null)[] = [];
    const sleep = sleepOf(async (at) => {
        calls.push(at);
        return at === null ? true : saved.promise;
    });
    await sleep.retractAtBoot();
    const prepared = sleep.prepare(9_000_000, 0);
    const cancelled = sleep.cancel(0);
    saved.resolve(true);
    expect(await prepared).toBe(true);
    expect(await cancelled).toBe(true);
    expect(calls).toEqual([null, 9_000_000, null]);
});

test("a boot after a sleep that armed an alarm is the alarm's, once it has taken charge, and only once", async () => {
    const first = sleepOf(async () => true);
    await first.retractAtBoot();
    expect(first.alarmBoot()).toBe(false);
    expect(await first.prepare(9_000_000, 0)).toBe(true);

    const woken = sleepOf(async () => true);
    expect(woken.alarmBoot()).toBe(false);
    await woken.retractAtBoot();
    expect(woken.alarmBoot()).toBe(true);
    // Read once: a later boot that this one never slept from is nobody's alarm.
    const again = sleepOf(async () => true);
    await again.retractAtBoot();
    expect(again.alarmBoot()).toBe(false);
});

test("an alarm that was not acknowledged, or was retracted, leaves no mark for the next boot", async () => {
    const refused = sleepOf(async (at) => at === null);
    await refused.retractAtBoot();
    expect(await refused.prepare(9_000_000, 0)).toBe(false);
    const afterRefusal = sleepOf(async () => true);
    await afterRefusal.retractAtBoot();
    expect(afterRefusal.alarmBoot()).toBe(false);

    expect(await afterRefusal.prepare(9_000_000, 0)).toBe(true);
    expect(await afterRefusal.cancel(0)).toBe(true);
    const afterCancel = sleepOf(async () => true);
    await afterCancel.retractAtBoot();
    expect(afterCancel.alarmBoot()).toBe(false);
});
