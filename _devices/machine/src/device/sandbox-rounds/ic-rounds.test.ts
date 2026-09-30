import { advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { startRounds } from "./ic-rounds.js";

/* The scheduler every background round runs on: a round is under way from its start to its end (the keeper reads that
   off the probation watch's), and the next is scheduled only once it has finished. */

afterEach(() => jest.useRealTimers());

test("a round reads as running from its start to its end, and the next waits for it to finish", async () => {
    jest.useFakeTimers();
    let started = 0;
    let open: () => void = () => undefined;
    const rounds = startRounds("test", () => undefined, 1_000, () => 1_000, async () => {
        started += 1;
        await new Promise<void>((resolve) => {
            open = resolve;
        });
    });
    expect(rounds.running()).toBe(false);
    await advanceTimersByTimeAsync(1_000);
    expect(rounds.running()).toBe(true);
    // Well past the next round's time: it is not started while this one is under way.
    await advanceTimersByTimeAsync(5_000);
    expect(started).toBe(1);
    open();
    await advanceTimersByTimeAsync(0);
    expect(rounds.running()).toBe(false);
    await advanceTimersByTimeAsync(1_000);
    expect(started).toBe(2);
    rounds.stop();
});

test("a round that throws is said under the round's name and still ends", async () => {
    jest.useFakeTimers();
    const lines: string[] = [];
    const rounds = startRounds("test", (line) => lines.push(line), 1_000, () => 60_000, async () => await Promise.reject(new Error("docker is wedged")));
    await advanceTimersByTimeAsync(1_000);
    expect(rounds.running()).toBe(false);
    expect(lines).toEqual(["test: skipped this round — docker is wedged"]);
    rounds.stop();
});
