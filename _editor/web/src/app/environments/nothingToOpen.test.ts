import { createNothingToOpen, NOTHING_TO_OPEN_PATH } from "./nothingToOpen";

const resume = { path: `/setup`, query: { sandbox: `pending` } };

describe(`where a reader with nothing to open lands`, () => {
    // Setup made a sandbox by arriving; Home's first run makes one on a press.
    it(`puts the reader on Home's first run, never on setup`, () => {
        expect(createNothingToOpen().settle(`/setup`)).toBe(NOTHING_TO_OPEN_PATH);
    });

    // Home offers the setup by name and finishes it in place, in a browser and in the desktop app alike.
    it(`keeps the reader on Home over an unfinished setup of their own`, () => {
        expect(createNothingToOpen().settle(resume)).toBe(NOTHING_TO_OPEN_PATH);
    });

    it(`leaves every other answer of the gate alone: the shell, recovery, an outage`, () => {
        const rule = createNothingToOpen();
        expect(rule.settle(true)).toBe(true);
        expect(rule.settle(`/recover`)).toBe(`/recover`);
        const outage = { path: `/platform-unavailable`, query: { returnTo: `/agents` } };
        expect(rule.settle(outage)).toBe(outage);
    });
});
