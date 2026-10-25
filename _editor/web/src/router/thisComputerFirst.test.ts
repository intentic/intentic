import { createStandAside, NO_SANDBOX_PATH, type StandAsideHost } from "./thisComputerFirst";

const host = (inApp = true): StandAsideHost & { shownThisComputer: number; handedBack: () => void } => {
    let handed = false;
    const made = {
        shownThisComputer: 0,
        inApp: () => inApp,
        showThisComputer: () => {
            made.shownThisComputer += 1;
        },
        handedBack: () => {
            handed = true;
        },
        takeHandedBack: () => {
            const was = handed;
            handed = false;
            return was;
        },
    };
    return made;
};

describe(`the desktop app's workspace with nothing to open`, () => {
    it(`puts the reader on This computer, never on setup, which would make a sandbox by arriving`, () => {
        const app = host();
        expect(createStandAside(app).settle(`/setup`)).toBe(NO_SANDBOX_PATH);
        expect(app.shownThisComputer).toBe(1);
    });

    // A browser has no This computer: Home's first run is where it makes a sandbox, on a press rather than by arriving.
    it(`puts a browser on Home's first run, never on setup`, () => {
        const browser = host(false);
        expect(createStandAside(browser).settle(`/setup`)).toBe(`/home`);
        expect(browser.shownThisComputer).toBe(0);
    });

    it(`still resumes an unfinished setup of the reader's own in a browser`, () => {
        const resume = { path: `/setup`, query: { sandbox: `pending` } };
        expect(createStandAside(host(false)).settle(resume)).toBe(resume);
    });

    it(`leaves every other answer of the gate alone: the shell, recovery, an unfinished setup of the reader's own`, () => {
        const app = host();
        const aside = createStandAside(app);
        const resume = { path: `/setup`, query: { sandbox: `pending` } };
        expect(aside.settle(true)).toBe(true);
        expect(aside.settle(`/recover`)).toBe(`/recover`);
        expect(aside.settle(resume)).toBe(resume);
        expect(app.shownThisComputer).toBe(0);
    });

    it(`only waits when the reader was already handed to a folder of this computer, and only that once`, () => {
        const app = host();
        const aside = createStandAside(app);
        app.handedBack();
        expect(aside.settle(`/setup`)).toBe(NO_SANDBOX_PATH);
        expect(app.shownThisComputer).toBe(0);
        expect(aside.settle(`/setup`)).toBe(NO_SANDBOX_PATH);
        expect(app.shownThisComputer).toBe(1);
    });

    it(`forgets a hand-back once the gate has answered, whatever it answered`, () => {
        const app = host();
        const aside = createStandAside(app);
        app.handedBack();
        aside.settle(true);
        aside.settle(`/setup`);
        expect(app.shownThisComputer).toBe(1);
    });
});
