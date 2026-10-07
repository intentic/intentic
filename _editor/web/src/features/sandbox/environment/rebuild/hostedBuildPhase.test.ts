import { hostedBuildPhase, SWAP_WINDOW_MS } from "./hostedBuildPhase";

// Where a hosted build stands for the recipe waiting to be built. The one that matters: a swap is given a window, after
// which a build the sandbox never came back on is `stalled`, and something can be pressed again.

const NOW = Date.parse(`2026-10-06T12:00:00.000Z`);
const iso = (ms: number): string => new Date(ms).toISOString();

it(`is idle with no build, or a build of some other recipe`, () => {
    expect(hostedBuildPhase(undefined, undefined, `h1`, NOW)).toEqual({ kind: `idle` });
    expect(hostedBuildPhase({ state: `failed`, hash: `older`, startedAt: iso(NOW) }, undefined, `h1`, NOW)).toEqual({ kind: `idle` });
});

it(`carries when a build began, and a failure's reason and log`, () => {
    expect(hostedBuildPhase({ state: `building`, hash: `h1`, startedAt: iso(NOW - 50 * 60_000) }, undefined, `h1`, NOW)).toEqual({
        kind: `building`,
        since: NOW - 50 * 60_000,
    });
    expect(hostedBuildPhase({ state: `failed`, hash: `h1`, startedAt: iso(NOW), error: `exit 100`, log: `E: nope` }, undefined, `h1`, NOW)).toEqual({
        kind: `failed`,
        error: `exit 100`,
        log: `E: nope`,
    });
});

it(`is switching for the swap's window only, and stalled after it or when the platform never pointed the sandbox at it`, () => {
    const built = (finished: number) => ({ state: `built` as const, hash: `h1`, startedAt: iso(finished - 60_000), finishedAt: iso(finished) });
    expect(hostedBuildPhase(built(NOW - 60_000), `h1`, `h1`, NOW)).toEqual({ kind: `switching` });
    expect(hostedBuildPhase(built(NOW - SWAP_WINDOW_MS), `h1`, `h1`, NOW)).toEqual({ kind: `stalled`, builtAt: NOW - SWAP_WINDOW_MS });
    expect(hostedBuildPhase(built(NOW - 60_000), `older`, `h1`, NOW)).toEqual({ kind: `stalled`, builtAt: NOW - 60_000 });
});
