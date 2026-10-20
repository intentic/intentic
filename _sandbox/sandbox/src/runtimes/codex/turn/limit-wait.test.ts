import { allowanceReopening, limitWait } from "./limit-wait.js";

const PATIENCE = 120_000;
const NOW = 1_800_000_000_000;
const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
    }
};

// A wait whose reopening is read as `reopensAt` answers (epoch seconds), counting the stops it sends.
const waitWith = (reopensAt: () => Promise<number | undefined>) => {
    const stops = { count: 0 };
    const wait = limitWait(() => (stops.count += 1), { patienceMs: PATIENCE, reopensAt, now: () => NOW });
    return { wait, stops };
};

describe("a rate-limited wait whose reopening is on file", () => {
    afterEach(() => jest.useRealTimers());

    test("is handed over at once when the reset is past patience, not after it", async () => {
        jest.useFakeTimers();
        const { wait, stops } = waitWith(async () => NOW / 1000 + 4 * 3600);
        wait.retrying();
        await flush();
        expect(wait.handedOver()).toBe(true);
        expect(stops.count).toBe(1);
        // The patience timer is gone with it: no second stop.
        jest.advanceTimersByTime(PATIENCE);
        expect(stops.count).toBe(1);
    });

    test("rides out a reset inside patience, and the timer still ends a wait that outlasts it", async () => {
        jest.useFakeTimers();
        const { wait, stops } = waitWith(async () => NOW / 1000 + 30);
        wait.retrying();
        await flush();
        expect(wait.handedOver()).toBe(false);
        jest.advanceTimersByTime(PATIENCE);
        expect(wait.handedOver()).toBe(true);
        expect(stops.count).toBe(1);
    });

    test("keeps the timer as the fallback when no instant is known or the read fails", async () => {
        jest.useFakeTimers();
        for (const read of [async () => undefined, async () => { throw new Error("translator unreachable"); }]) {
            const { wait, stops } = waitWith(read);
            wait.retrying();
            await flush();
            expect(wait.handedOver()).toBe(false);
            jest.advanceTimersByTime(PATIENCE);
            expect(stops.count).toBe(1);
        }
    });

    test("does not hand over a wait the provider already answered while the reopening was being read", async () => {
        const { promise, resolve } = Promise.withResolvers<number | undefined>();
        const { wait, stops } = waitWith(() => promise);
        wait.retrying();
        wait.answered();
        resolve(NOW / 1000 + 4 * 3600);
        await flush();
        expect(wait.handedOver()).toBe(false);
        expect(stops.count).toBe(0);
        wait.dispose();
    });
});

describe("the reopening an allowance names", () => {
    test("is its fleet's reopen only while no account can serve", async () => {
        expect(await allowanceReopening(async () => ({ kind: "spent", accounts: 2, reopensAt: 42 }))()).toBe(42);
        expect(await allowanceReopening(async () => ({ kind: "serving", serving: 1, accounts: 2 }))()).toBeUndefined();
        expect(await allowanceReopening(async () => ({ kind: "spent", accounts: 1 }))()).toBeUndefined();
        expect(await allowanceReopening(async () => ({ kind: "unknown" }))()).toBeUndefined();
    });
});
