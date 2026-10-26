import { remainingMs } from "../stagedSteps";

// How long a run has left is said only from lengths something measured: the steps still to come, and what the running
// one has left of its own. A guess for one step is no promise for the run, so a single unmeasured step says nothing.

const step = (key: string, expectedMs?: number) => ({ key, label: key, note: ``, weight: 1, expectedMs });
const MINUTE = 60_000;

it(`counts the steps to come in full, and what the running one has left of its own length`, () => {
    const steps = [step(`compile`, MINUTE), step(`image`, 4 * MINUTE), step(`swap`, MINUTE / 2)];

    expect(remainingMs(steps, `compile`, 20_000)).toEqual({ ms: 40_000 + 4.5 * MINUTE, overdue: false });
    expect(remainingMs(steps, `swap`, 0)).toEqual({ ms: MINUTE / 2, overdue: false });
});

it(`says the running step is overdue once it has outlasted its own length, rather than counting down past nothing`, () => {
    const steps = [step(`compile`, MINUTE), step(`image`, 4 * MINUTE)];

    expect(remainingMs(steps, `compile`, 2 * MINUTE)).toEqual({ ms: 4 * MINUTE, overdue: true });
});

it(`says nothing when any step was never measured`, () => {
    expect(remainingMs([step(`a`, MINUTE), step(`b`)], `a`, 0)).toBeUndefined();
    expect(remainingMs([step(`a`, MINUTE)], `missing`, 0)).toBeUndefined();
});
