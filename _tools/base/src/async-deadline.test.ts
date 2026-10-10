import { TimeoutError, withDeadline } from "./async.js";

// withDeadline's contract at its edges: a TimeoutError at the deadline whatever the work does when told to stop, and the
// caller's reason, with nothing left unhandled, when the caller stopped before the work began.

test("the deadline rejects with its TimeoutError even when the work rejects with its own error the moment its signal aborts", async () => {
    // The shape of an event-emitter API wrapped by hand: it rejects with its own error the moment its signal aborts.
    const task = (signal: AbortSignal): Promise<never> =>
        new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(new Error("cancelled by its signal")), { once: true });
        });
    const outcome = await withDeadline(task, 10).then(
        () => "resolved",
        (error: unknown) => (error instanceof TimeoutError ? "TimeoutError" : `other: ${(error as Error).message}`),
    );
    expect(outcome).toBe("TimeoutError");
});

test("a caller that stopped before the work began is answered with its own reason, and a work that throws synchronously leaves nothing unhandled", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
        unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
        const caller = new AbortController();
        caller.abort(new Error("stopped before it started"));
        const outcome = await withDeadline(
            (() => {
                throw new Error("sync throw");
            }) as unknown as (signal: AbortSignal) => Promise<never>,
            1_000,
            { signal: caller.signal },
        ).then(
            () => "resolved",
            (error: unknown) => (error as Error).message,
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(outcome).toBe("stopped before it started");
        expect(unhandled).toEqual([]);
    } finally {
        process.off("unhandledRejection", onUnhandled);
    }
});

test("work that finishes in time resolves with its value, and a caller's stop mid-way rejects with the caller's reason", async () => {
    expect(await withDeadline(async () => 7, 1_000)).toBe(7);
    const caller = new AbortController();
    const running = withDeadline(
        (signal) =>
            new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(new Error("the work's own error")), { once: true });
            }),
        5_000,
        { signal: caller.signal },
    );
    caller.abort(new Error("the caller stopped it"));
    await expect(running).rejects.toThrow("the caller stopped it");
});
