import "@intentic/testing/dom";
import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { usePoll, usePollWhile } from "@intentic/ui/async";
import { effectScope, nextTick, ref } from "vue";

// The kit's one "ask again until it has happened": it ends when the check says done or the deadline passes, never runs
// two checks at once, and looks at once when the window is looked at again, which a hidden tab's throttled interval
// would otherwise put off by a minute or more.

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
});
afterEach(() => jest.useRealTimers());

const inScope = <T>(make: () => T) => {
    const scope = effectScope();
    return { value: scope.run(make)!, stop: () => scope.stop() };
};

test("looks at once and then every period, and ends the moment the check says done", async () => {
    let looks = 0;
    const { value: poll } = inScope(() => usePoll({ everyMs: 1_000, check: () => (looks += 1) === 3 }));

    poll.start();
    await advanceTimersByTimeAsync(0);
    expect(looks).toBe(1);
    await advanceTimersByTimeAsync(2_000);
    expect({ looks, polling: poll.polling.value }).toEqual({ looks: 3, polling: false });
    await advanceTimersByTimeAsync(5_000);
    expect(looks).toBe(3);
});

test("gives up at its deadline, and a second start moves the deadline out instead of starting a second clock", async () => {
    let looks = 0;
    const { value: poll } = inScope(() => usePoll({ everyMs: 1_000, check: () => void (looks += 1) }));

    poll.start(2_500);
    await advanceTimersByTimeAsync(2_000);
    poll.start(5_000);
    await advanceTimersByTimeAsync(4_000);
    expect(poll.polling.value).toBe(true);
    await advanceTimersByTimeAsync(2_000);

    // One look at the start, one a second up to the moved deadline at seven seconds, and the first look past it (at
    // eight) is the last.
    expect({ looks, polling: poll.polling.value }).toEqual({ looks: 9, polling: false });
});

test("never runs a second check while the first is still out", async () => {
    let looks = 0;
    let answer: (() => void) | undefined;
    const { value: poll } = inScope(() =>
        usePoll({
            everyMs: 1_000,
            check: () =>
                new Promise<void>((resolve) => {
                    looks += 1;
                    answer = resolve;
                }),
        }),
    );

    poll.start();
    await advanceTimersByTimeAsync(5_000);
    expect(looks).toBe(1);
    answer?.();
    await advanceTimersByTimeAsync(1_000);
    expect(looks).toBe(2);
});

test("a failed look is not the end of the wait", async () => {
    let looks = 0;
    const { value: poll } = inScope(() =>
        usePoll({
            everyMs: 1_000,
            check: () => {
                looks += 1;
                throw new Error(`not up yet`);
            },
        }),
    );

    poll.start();
    await advanceTimersByTimeAsync(2_000);
    expect({ looks, polling: poll.polling.value }).toEqual({ looks: 3, polling: true });
});

test("looks again the moment the window is shown or focused, without waiting out the period", async () => {
    let looks = 0;
    const { value: poll } = inScope(() => usePoll({ everyMs: 60_000, check: () => void (looks += 1), immediate: false }));
    poll.start();

    document.dispatchEvent(new Event(`visibilitychange`));
    await advanceTimersByTimeAsync(0);
    window.dispatchEvent(new Event(`focus`));
    await advanceTimersByTimeAsync(0);

    expect(looks).toBe(2);
});

test("a stopped poll, or one whose scope is gone, looks no more", async () => {
    let looks = 0;
    const { value: poll, stop } = inScope(() => usePoll({ everyMs: 1_000, check: () => void (looks += 1), immediate: false }));
    poll.start();
    stop();

    await advanceTimersByTimeAsync(5_000);
    window.dispatchEvent(new Event(`focus`));
    await advanceTimersByTimeAsync(0);

    expect({ looks, polling: poll.polling.value }).toEqual({ looks: 0, polling: false });
});

test("a poll held to a condition runs while it holds and stops when it lets go", async () => {
    let looks = 0;
    const active = ref(false);
    const { value: poll } = inScope(() => usePollWhile(active, { everyMs: 1_000, check: () => void (looks += 1), immediate: false }));

    await advanceTimersByTimeAsync(3_000);
    active.value = true;
    await nextTick();
    await advanceTimersByTimeAsync(2_000);
    active.value = false;
    await nextTick();
    await advanceTimersByTimeAsync(3_000);

    expect({ looks, polling: poll.polling.value }).toEqual({ looks: 2, polling: false });
});
