import { enterStep, expectedMs, finishStep, graceSecondsLeft, latestLine, removalSteps, startProgress, stepsLeft, stepWeight } from "./removalPlan";

// A removal showed nothing but a spinner, could not be taken back, and a retry after a half-finished one redid work or
// was refused. These pin the order that keeps a handle to retry from, the resume, and the countdown's arithmetic.

describe(`removalSteps`, () => {
    it(`puts the machine first and the account row last, so a failure out there leaves the row to retry from`, () => {
        expect(removalSteps(true)).toEqual([`device`, `account`]);
        expect(removalSteps(false)).toEqual([`account`]);
    });
});

describe(`resuming`, () => {
    it(`starts a retry on the first step an earlier attempt did not finish, carrying what it did`, () => {
        const progress = startProgress([`device`, `account`], [`device`], 1_000);
        expect(progress.stage).toBe(`account`);
        expect(progress.done).toEqual([`device`]);
        expect(stepsLeft(progress)).toEqual([`account`]);
    });

    it(`drops a finished step the new plan no longer takes (removing from the account only, after the machine refused)`, () => {
        const progress = startProgress([`account`], [`device`], 1_000);
        expect(progress.done).toEqual([]);
        expect(stepsLeft(progress)).toEqual([`account`]);
    });

    it(`keeps a step's first clock when it is entered again, and finishes a step once`, () => {
        const started = startProgress([`device`, `account`], [], 1_000);
        const again = enterStep(started, `device`, 9_000);
        expect(again.stageAt.device).toBe(1_000);
        const moved = enterStep(finishStep(finishStep(again, `device`), `device`), `account`, 5_000);
        expect(moved.done).toEqual([`device`]);
        expect(moved.stageAt).toEqual({ device: 1_000, account: 5_000 });
    });
});

describe(`the countdown`, () => {
    it(`counts whole seconds down to zero, never below`, () => {
        expect(graceSecondsLeft(6_000, 1_000)).toBe(5);
        expect(graceSecondsLeft(6_000, 5_100)).toBe(1);
        expect(graceSecondsLeft(6_000, 6_000)).toBe(0);
        expect(graceSecondsLeft(6_000, 9_000)).toBe(0);
    });
});

describe(`the bar`, () => {
    it(`sizes each step by how long it usually takes`, () => {
        const steps = removalSteps(true);
        expect(expectedMs(steps)).toBe(32_000);
        expect(stepWeight(`device`, steps) + stepWeight(`account`, steps)).toBeCloseTo(1);
        expect(stepWeight(`device`, steps)).toBeGreaterThan(stepWeight(`account`, steps));
    });

    it(`reads the machine's latest line that says anything`, () => {
        expect(latestLine([`Removing work`, ``, `  `])).toBe(`Removing work`);
        expect(latestLine([])).toBeUndefined();
    });
});
