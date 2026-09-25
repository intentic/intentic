import { oneShotDeadline } from "./adapter.js";

// The clock every one-shot helper runs under: deadline and cancel stop the call alike, and only the deadline names itself.

const stopped = (): { readonly stop: () => void; readonly calls: () => number; readonly once: Promise<void> } => {
    let calls = 0;
    let resolve: () => void = () => {};
    const once = new Promise<void>((settle) => {
        resolve = settle;
    });
    return {
        stop: () => {
            calls += 1;
            resolve();
        },
        calls: () => calls,
        once,
    };
};

test("a deadline that passes stops the call and names itself in every failure", async () => {
    const call = stopped();
    const deadline = oneShotDeadline(new AbortController().signal, 10, call.stop);
    await call.once;
    deadline.release();

    const torn = new Error("socket hang up");
    const claimed = deadline.claim(torn) as Error;
    expect(deadline.expired()).toBe(true);
    expect(deadline.unanswered().message).toBe("the model did not answer within 0.01s");
    expect(claimed.message).toBe("the model did not answer within 0.01s");
    expect(claimed.cause).toBe(torn);
});

test("the caller's cancel stops the call without the deadline claiming what it threw", async () => {
    const call = stopped();
    const caller = new AbortController();
    const deadline = oneShotDeadline(caller.signal, 60_000, call.stop);
    caller.abort();
    await call.once;
    deadline.release();

    const torn = new Error("aborted");
    expect(deadline.expired()).toBe(false);
    expect(deadline.unanswered().message).toBe("the model did not answer");
    expect(deadline.claim(torn)).toBe(torn);
});

test("a released deadline stops nothing, whatever fires after it", async () => {
    const call = stopped();
    const caller = new AbortController();
    const deadline = oneShotDeadline(caller.signal, 5, call.stop);
    deadline.release();
    caller.abort();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(call.calls()).toBe(0);
    expect(deadline.expired()).toBe(false);
});

test("the sentence can name a different figure than the clock runs to", async () => {
    const call = stopped();
    const deadline = oneShotDeadline(new AbortController().signal, 10, call.stop, 20_000);
    await call.once;
    deadline.release();

    expect(deadline.unanswered().message).toBe("the model did not answer within 20s");
});
