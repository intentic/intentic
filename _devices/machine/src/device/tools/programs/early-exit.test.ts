import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { waitForEarlyExit } from "./app-wait.js";

afterEach(() => jest.useRealTimers());

test("an early exit waits for its record even when the write takes longer than the startup window", async () => {
    jest.useFakeTimers();
    const record = Promise.withResolvers<void>();
    let answered = false;
    const waiting = waitForEarlyExit(Promise.resolve(), record.promise, 1_500).then((early) => {
        answered = true;
        return early;
    });

    await advanceTimersByTimeAsync(3_000);
    expect(answered).toBe(false);
    record.resolve();
    expect(await waiting).toBe(true);
});

test("a program still running at the startup deadline does not wait for an exit record", async () => {
    jest.useFakeTimers();
    const exit = Promise.withResolvers<void>();
    const record = Promise.withResolvers<void>();
    const waiting = waitForEarlyExit(exit.promise, record.promise, 1_500);

    await advanceTimersByTimeAsync(1_500);
    expect(await waiting).toBe(false);
});
