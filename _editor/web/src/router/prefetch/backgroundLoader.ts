import type { WarmTask } from "./warmPlan";

// Reads what warmPlan says surfaces will want next, one thing at a time, in the browser's idle gaps.
// Self-throttling: one read in flight, gap proportional to its cost, stands aside while paused or busy.
// Failures and stalls end quietly; nothing here is user-visible.

// Tuning constants for the loop's pacing.

// Floor between reads regardless of cost; keeps even a fast daemon reading as a trickle.
const MIN_GAP_MS = 250;
// Ceiling so one slow read doesn't stall the loop for long.
const MAX_GAP_MS = 4_000;
// Fraction of the last read's cost spent waiting; 1 caps request time at half the loop's wall clock.
const GAP_RATIO = 1;

// Wait between beats when idle, paused, or yielding; cheap over an hour, still prompt to resume.
const IDLE_BEAT_MS = 1_000;

// Caps consecutive yields to `busy`; a hung read is never timed out, so this bounds how long it blocks.
const MAX_YIELDS = 10;

// How long a wish that read cleanly but stayed unsatisfied is set aside before another try.
const STALL_RETRY_MS = 60_000;

// Consecutive failures treated as the daemon being unreachable, not one bad file.
const FAILURE_STREAK = 3;
// How long the loader stands down after a failure streak.
const COOL_OFF_MS = 30_000;

// `paused` describes the session (nobody looking, daemon down, cooling off); `busy` describes this
// moment (a click or stream in flight). Different timescales, kept separate.
export interface LoaderGates {
    readonly paused: () => boolean;
    readonly busy: () => boolean;
}

// Injected so tests can drive the loop without real timers. `now` is used only for durations.
export interface LoaderPace {
    readonly idle: () => Promise<void>;
    readonly wait: (ms: number) => Promise<void>;
    readonly now: () => number;
}

// What one beat did, for tests and debug counters only, never shown to the user.
// `stalled` is a read that answered but left the wish unsatisfied, not counted as a plain read.
export interface LoaderBeat {
    readonly outcome: "read" | "stalled" | "failed" | "idle" | "paused" | "yielded";
    readonly key?: string;
}

// Gap after a read: proportional to its cost, clamped to [MIN_GAP_MS, MAX_GAP_MS]. Exported so tests
// reuse this arithmetic instead of duplicating it.
export const gapAfter = (elapsedMs: number): number => Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, elapsedMs * GAP_RATIO));

// A `have` that throws (cache torn down) is treated as in hand; the safe default.
const inHand = (task: WarmTask): boolean => {
    try {
        return task.have();
    } catch {
        return true;
    }
};

// Linear scan each beat over a plan bounded at PLAN_LIMIT; cheap even past hundreds of satisfied wishes,
// and lets a wish gone cold again be picked up without notice. `resting` maps a stalled wish's key to
// when it was set aside.
const nextTask = (plan: readonly WarmTask[], resting: ReadonlyMap<string, number>, now: number): WarmTask | undefined =>
    plan.find((task) => {
        const restedAt = resting.get(task.key);
        return (restedAt === undefined || now - restedAt >= STALL_RETRY_MS) && !inHand(task);
    });

// Runs until `stopped()`; the caller owns starting and stopping one loader per session. Never rejects:
// every failure inside is a warm that didn't happen, with no caller to act on it.
export const runBackgroundLoader = async (
    plan: () => readonly WarmTask[],
    gates: LoaderGates,
    pace: LoaderPace,
    stopped: () => boolean,
    // Called every beat, synchronously; must not throw.
    onBeat: (beat: LoaderBeat) => void = () => undefined,
): Promise<void> => {
    let failures = 0;
    let yields = 0;
    // Stalled wishes and when each was set aside; never pruned, plan size already bounds it.
    const resting = new Map<string, number>();
    while (!stopped()) {
        // Idle first, always: this beat runs in a gap the browser offered, not mid-frame.
        await pace.idle();
        if (stopped()) {
            return;
        }
        if (gates.paused()) {
            onBeat({ outcome: `paused` });
            await pace.wait(IDLE_BEAT_MS);
            continue;
        }
        if (gates.busy() && yields < MAX_YIELDS) {
            yields += 1;
            onBeat({ outcome: `yielded` });
            await pace.wait(IDLE_BEAT_MS);
            continue;
        }
        yields = 0;
        const task = nextTask(plan(), resting, pace.now());
        if (task === undefined) {
            onBeat({ outcome: `idle` });
            await pace.wait(IDLE_BEAT_MS);
            continue;
        }
        const started = pace.now();
        const ok = await task.read().then(
            () => true,
            () => false,
        );
        if (stopped()) {
            return;
        }
        if (ok) {
            failures = 0;
            // Checked once here rather than trusted: did the read actually satisfy the wish?
            const settled = inHand(task);
            if (settled) {
                resting.delete(task.key);
            } else {
                resting.set(task.key, pace.now());
            }
            onBeat({ outcome: settled ? `read` : `stalled`, key: task.key });
            await pace.wait(gapAfter(pace.now() - started));
            continue;
        }
        onBeat({ outcome: `failed`, key: task.key });
        failures += 1;
        if (failures >= FAILURE_STREAK) {
            failures = 0;
            await pace.wait(COOL_OFF_MS);
            continue;
        }
        // A lone failure paces off normally; only a streak means the daemon is down.
        await pace.wait(gapAfter(pace.now() - started));
    }
};

// The real, browser-driven pace.

// Safari has no requestIdleCallback; this timeout stands in for it.
const IDLE_FALLBACK_MS = 200;

const whenIdle = (): Promise<void> =>
    new Promise((resolve) => {
        if (window.requestIdleCallback === undefined) {
            window.setTimeout(resolve, IDLE_FALLBACK_MS);
            return;
        }
        window.requestIdleCallback(() => resolve());
    });

export const browserPace: LoaderPace = {
    idle: whenIdle,
    wait: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
    now: () => performance.now(),
};
