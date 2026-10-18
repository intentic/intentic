import { pino } from "pino";
import { testConfig } from "../../env.config.testing.js";
import { createHostedSleep } from "./hosted-sleep.js";

const logger = pino({ level: "silent" });

test("boot cancels the old alarm before a new preparation can replace it", async () => {
    const boot = Promise.withResolvers<boolean>();
    const calls: (number | null)[] = [];
    const sleep = createHostedSleep(testConfig, logger, async (at) => {
        calls.push(at);
        return at === null ? boot.promise : true;
    });
    const first = sleep.prepare(9_000_000);
    const second = sleep.prepare(3_000_000);
    expect(calls).toEqual([null]);
    boot.resolve(true);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(calls).toEqual([null, 9_000_000, 3_000_000]);
});

test("an unacknowledged or failed write forbids sleep and the next attempt can recover", async () => {
    const save = jest.fn(async (at: number | null) => {
        if (at === 1) { return false; }
        if (at === 2) { throw new Error("platform unreachable"); }
        return true;
    });
    const sleep = createHostedSleep(testConfig, logger, save);
    expect(await sleep.prepare(1)).toBe(false);
    expect(await sleep.prepare(2)).toBe(false);
    expect(await sleep.prepare(3)).toBe(true);
    expect(save.mock.calls).toEqual([[null], [1], [2], [3]]);
});

test("sleep with no promises cancels a previously armed alarm", async () => {
    const calls: (number | null)[] = [];
    const sleep = createHostedSleep(testConfig, logger, async (at) => { calls.push(at); return true; });
    expect(await sleep.prepare(9_000_000)).toBe(true);
    expect(await sleep.prepare(0)).toBe(true);
    expect(calls).toEqual([null, 9_000_000, null]);
});

test("a rejected final sleep check cancels after its in-flight registration", async () => {
    const saved = Promise.withResolvers<boolean>();
    const calls: (number | null)[] = [];
    const sleep = createHostedSleep(testConfig, logger, async (at) => {
        calls.push(at);
        return at === null ? true : saved.promise;
    });
    const prepared = sleep.prepare(9_000_000);
    const cancelled = sleep.cancel();
    saved.resolve(true);
    expect(await prepared).toBe(true);
    expect(await cancelled).toBe(true);
    expect(calls).toEqual([null, 9_000_000, null]);
});
