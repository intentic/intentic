import { createNothingToOpen, NOTHING_TO_OPEN_PATH } from "./nothingToOpen";

const resume = { path: `/setup`, query: { sandbox: `pending` } };

describe(`where a reader with nothing to open lands`, () => {
    // Setup makes a sandbox by arriving; Home's first run makes one on a press.
    it(`puts a browser on Home's first run, never on setup`, () => {
        expect(createNothingToOpen({ inApp: () => false }).settle(`/setup`)).toBe(NOTHING_TO_OPEN_PATH);
    });

    // The app's reader stays in the workspace they signed in to, with its rail: never This computer, never setup.
    it(`puts the desktop app's reader on Home's first run too`, () => {
        expect(createNothingToOpen({ inApp: () => true }).settle(`/setup`)).toBe(NOTHING_TO_OPEN_PATH);
    });

    it(`still resumes an unfinished setup of the reader's own in a browser`, () => {
        expect(createNothingToOpen({ inApp: () => false }).settle(resume)).toBe(resume);
    });

    // In the app /setup hands the install over and This computer is swapped in over the workspace; Home offers the setup
    // by name and runs it in place.
    it(`keeps the app's reader on Home over an unfinished setup of their own`, () => {
        expect(createNothingToOpen({ inApp: () => true }).settle(resume)).toBe(NOTHING_TO_OPEN_PATH);
    });

    it(`leaves every other answer of the gate alone: the shell, recovery, an outage`, () => {
        for (const inApp of [true, false]) {
            const rule = createNothingToOpen({ inApp: () => inApp });
            expect(rule.settle(true)).toBe(true);
            expect(rule.settle(`/recover`)).toBe(`/recover`);
            const outage = { path: `/platform-unavailable`, query: { returnTo: `/agents` } };
            expect(rule.settle(outage)).toBe(outage);
        }
    });
});
