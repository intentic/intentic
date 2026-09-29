import type { AgentSummary } from "@intentic/sandbox-contract";
import { sandboxRef, sandboxValue } from "@intentic/extension-api";

// How far this browser's clock is from the sandbox's, read off the roster itself: every time the sandbox, in a frame,
// moves a conversation's `updatedAt` it has just stamped it with its own clock, so the moment that frame lands here,
// `Date.now() - updatedAt` is the offset plus however long the frame took to arrive. The smallest such reading over the
// last few minutes is the offset with the least delay in it. Counting a running turn's elapsed from the sandbox's
// `startedAt` against a clock 96 s fast showed a turn one second old as "1m 36s"; readings of the sandbox's instants
// ask `sandboxNow()` instead of `Date.now()`.
// Why not the HTTP `Date` header: the sandbox answers from another origin, where a browser hides that header unless
// the server exposes it, and the roster already carries the sandbox's clock on every frame.

// A reading older than this is dropped, so a clock the machine corrected since is followed within minutes.
export const SAMPLE_TTL_MS = 10 * 60 * 1_000;
// Offsets under this are delivery delay, not a wrong clock, and are left alone: correcting by them would only make a
// fresh turn's first second jitter.
export const SKEW_FLOOR_MS = 2_000;
// Readings kept at most; the minimum of a few dozen is as good as the minimum of hundreds.
const MAX_SAMPLES = 64;

interface Sample {
    readonly offset: number;
    readonly at: number;
}

// Per sandbox: another box's clock is another clock.
const samples = sandboxValue<Sample[]>(() => []);

// The offset in effect, in ms (browser minus sandbox); reactive so every clock reading it redraws when it settles.
export const clockOffset = sandboxRef(() => 0);

// The best reading among `offsets`: the smallest, since every delay only ever adds to it; zero under the floor.
export const offsetOf = (offsets: readonly number[]): number => {
    if (offsets.length === 0) {
        return 0;
    }
    const least = Math.min(...offsets);
    return Math.abs(least) < SKEW_FLOOR_MS ? 0 : least;
};

// Reads a roster frame against the one before it: each conversation the sandbox restamped in it is one reading. A new
// id is not one (a restored or first-seen card carries an old instant), nor is an instant that went back.
export const observeRoster = (
    before: readonly Pick<AgentSummary, "id" | "updatedAt">[],
    after: readonly Pick<AgentSummary, "id" | "updatedAt">[],
    now: number = Date.now(),
): void => {
    const previous = new Map(before.map((agent) => [agent.id, agent.updatedAt] as const));
    const fresh: Sample[] = [];
    for (const agent of after) {
        const was = previous.get(agent.id);
        if (was !== undefined && agent.updatedAt > was) {
            fresh.push({ offset: now - agent.updatedAt, at: now });
        }
    }
    if (fresh.length === 0) {
        return;
    }
    const kept = [...samples.value.filter((sample) => now - sample.at < SAMPLE_TTL_MS), ...fresh].slice(-MAX_SAMPLES);
    samples.value = kept;
    const next = offsetOf(kept.map((sample) => sample.offset));
    if (next !== clockOffset.value) {
        clockOffset.value = next;
    }
};

// This browser's `now` on the sandbox's clock, for counting to or from an instant the sandbox stamped.
export const sandboxNow = (now: number = Date.now()): number => now - clockOffset.value;

// Forgets every reading, for a test.
export const resetSandboxClock = (): void => {
    samples.value = [];
    clockOffset.value = 0;
};
