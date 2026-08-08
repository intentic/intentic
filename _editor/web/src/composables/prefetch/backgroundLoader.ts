import type { WarmTask } from "./warmPlan";

/* READING WHAT THE READER IS ABOUT TO ASK FOR — for the whole app, not for one panel.
 *
 * Everything in this product is a round trip to a daemon on the far side of a tunnel, on a machine that may be
 * busy building something. The user pays that trip at the exact moment they are standing still waiting for it —
 * the click — while the seconds before it, spent scanning a board deciding what to open, went unused. This walks
 * that gap: it asks the surfaces what they would want in hand (warmPlan) and reads it, one thing at a time, in
 * the spaces between what the user and the app are already doing.
 *
 * IT IS A TRICKLE, AND IT IS BUILT TO BE INCAPABLE OF A BURST. That is not a rate limiter bolted on afterwards;
 * it is the shape of the loop, and every rule that makes it true is here rather than scattered across callers:
 *
 *   · ONE AT A TIME. The next read is not issued until the previous one has answered. The daemon therefore sees
 *     a single reader working down a list — which is what this is — instead of forty simultaneous ones, and the
 *     loader SELF-THROTTLES against a busy daemon for free: slow answers space the walk out on their own.
 *   · A GAP PROPORTIONAL TO WHAT THE LAST READ COST. One-at-a-time alone still means a fast daemon is asked
 *     continuously. So each read is followed by a pause scaled to how long it took: a quick answer earns a short
 *     one, an expensive answer earns a long one. A workspace under load is left alone without anything having to
 *     measure "load".
 *   · ONLY IN THE GAPS. Every step waits for an idle callback first, so it yields to rendering, to the user's
 *     own clicks, and to a streaming turn's frames.
 *   · IT STANDS ASIDE. While anything the user actually asked for is in flight, the loader spends its beat
 *     waiting instead of adding a request beside it. What is on screen and still loading is, by construction,
 *     always served first.
 *   · NOBODY LOOKING, NOTHING LOADING. Paused entirely while no window of the app is on screen.
 *   · FAILURES END QUIETLY. A failed warm is a warm that did not happen: nothing retries, and the click that
 *     follows makes the same request for real and shows the user whatever went wrong. A RUN of failures means
 *     the daemon is gone rather than that one file is unreadable, so it sleeps the whole loader off for a while
 *     instead of walking the rest of the plan into the same wall.
 *
 * Nothing here reports and nothing here is user-visible. A loader that surfaced its own progress would be
 * telling the user about work that exists precisely so they never have to think about it. */

/* --- the constants, and what each one is bounding ------------------------------------------------------- */

// The floor between two reads, however cheap the last one was. At this spacing a perfectly fast daemon is asked
// four times a second at the absolute most — enough to warm a board in a few seconds, slow enough that the
// network panel reads as a trickle rather than a flood.
const MIN_GAP_MS = 250;
// The ceiling, so a single pathological read (a huge diff over a cold tunnel) doesn't park the loader for a
// minute afterwards.
const MAX_GAP_MS = 4_000;
// How much of the last read's cost is paid back as quiet. 1 means the loader spends at most half its wall-clock
// time with a request open, which is the honest reading of "gentle": whatever the daemon is doing for everyone
// else, this asks for no more than an equal share of the time it has left.
const GAP_RATIO = 1;

// The beat when there is nothing to do — no plan, paused, or standing aside. Long enough to cost nothing while
// the user works for an hour, short enough that the loader picks a new plan up promptly.
const IDLE_BEAT_MS = 1_000;

/* HOW LONG STANDING ASIDE IS ALLOWED TO LAST. `busy` is meant to describe a moment — a click's read is in
 * flight — and yielding to it is free because it clears in one round trip. But nothing in this app times a
 * daemon read out, so a single hung request would otherwise hold the gate closed for the rest of the session
 * and the loader would sit there politely forever. Past this many consecutive yields it takes its beat anyway:
 * one extra request beside a request that is never coming back is not the thing that broke that session. */
const MAX_YIELDS = 10;

// Consecutive failures that mean "the daemon is not there", rather than "that one file could not be read".
const FAILURE_STREAK = 3;
// …and how long the loader stands down after one. The reconnect machinery is already working the problem; this
// just makes sure the loader isn't adding to the pile while it does.
const COOL_OFF_MS = 30_000;

/* Whether this beat may spend a request, and it is deliberately two questions rather than one.
 *
 * `paused` is about the SESSION: nobody is looking, the daemon is unreachable, the loader is sleeping off a run
 * of failures. `busy` is about THIS MOMENT: the user's own read is in flight, or an agent is streaming. They
 * are separated because they resolve on completely different timescales — a pause can last an hour, a busy
 * moment lasts one round trip — and folding them together made the loader either too eager after a pause or too
 * sleepy after a click. */
export interface LoaderGates {
    readonly paused: () => boolean;
    readonly busy: () => boolean;
}

// Injected so a test can step the loop without real time or real idle callbacks. `now` is only ever used for
// durations, so a test's monotonically-increasing counter is a complete implementation of it.
export interface LoaderPace {
    readonly idle: () => Promise<void>;
    readonly wait: (ms: number) => Promise<void>;
    readonly now: () => number;
}

// What one beat did, for the tests and for the debug counters — never for the user (see the header).
export interface LoaderBeat {
    readonly outcome: "read" | "failed" | "idle" | "paused" | "yielded";
    readonly key?: string;
}

/* THE GAP AFTER A READ. Proportional to what the read cost, clamped at both ends — see GAP_RATIO for why the
 * proportion is the rule rather than a fixed number of milliseconds. Exported because it is the whole of the
 * pacing policy and a test that has to reproduce the arithmetic to assert on it is testing its own copy. */
export const gapAfter = (elapsedMs: number): number => Math.min(MAX_GAP_MS, Math.max(MIN_GAP_MS, elapsedMs * GAP_RATIO));

/* The first thing in the plan that is not already in hand.
 *
 * A linear scan, every beat, over a plan bounded at PLAN_LIMIT. That looks wasteful and is the point: `have` is
 * a cache lookup, so scanning past four hundred satisfied wishes costs less than one of the round trips it
 * avoids — and it means a wish that goes COLD AGAIN (its list refreshed, its query invalidated) is picked up on
 * the very next beat without anything having to notify the loader that it did. A source can therefore declare
 * its list once and leave it declared, which is the property that makes the whole registry cheap to use. */
const nextTask = (plan: readonly WarmTask[]): WarmTask | undefined =>
    plan.find((task) => {
        try {
            return !task.have();
        } catch {
            // A `have` that throws is a surface reading a cache that has been torn down under it. Treat it as
            // "in hand" — the safe answer, because the alternative is warming into a store that is gone.
            return false;
        }
    });

/* Run until `stopped`. One loader per signed-in session; the caller owns starting and stopping it.
 *
 * Returns nothing and rejects for nothing: every failure inside is a warm that did not happen, and there is no
 * caller who could act on one. */
export const runBackgroundLoader = async (
    plan: () => readonly WarmTask[],
    gates: LoaderGates,
    pace: LoaderPace,
    stopped: () => boolean,
    // Every beat, for tests and debug counters. Called synchronously; must not throw.
    onBeat: (beat: LoaderBeat) => void = () => undefined,
): Promise<void> => {
    let failures = 0;
    let yields = 0;
    while (!stopped()) {
        // Idle FIRST, always — before the gates are even read. Whatever this beat turns out to be, it happens in
        // a gap the browser offered rather than in the middle of a frame the user is watching.
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
        const task = nextTask(plan());
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
        onBeat({ outcome: ok ? `read` : `failed`, key: task.key });
        if (ok) {
            failures = 0;
            await pace.wait(gapAfter(pace.now() - started));
            continue;
        }
        failures += 1;
        if (failures >= FAILURE_STREAK) {
            failures = 0;
            await pace.wait(COOL_OFF_MS);
            continue;
        }
        // A lone failure is one unreadable thing, not a broken daemon — pace off it normally so the plan's next
        // entry still gets its turn.
        await pace.wait(gapAfter(pace.now() - started));
    }
};

/* --- the pace the browser actually runs at ---------------------------------------------------------------- */

// Safari has no idle callback, so a beat of setTimeout stands in for it — the same bargain the chat
// transcript's warm-up makes.
const IDLE_FALLBACK_MS = 200;

export const whenIdle = (): Promise<void> =>
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
