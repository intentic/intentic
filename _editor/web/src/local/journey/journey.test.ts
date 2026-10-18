import type { LocalFolderSandbox, LocalMachineState } from "../../app/environments/localHost";
import { activeStep, type JourneyFacts, journeyOf } from "./journey";

// A folder's way to an agent, step by step: what each state of this computer's sandbox and of the folder's copy says
// about the sign-in, the sandbox and the copy, before the press (the dialog) and while it goes (the card).

const folderAt = (state: LocalFolderSandbox[`state`], more: Partial<LocalFolderSandbox> = {}): LocalFolderSandbox => ({
    name: `shop`,
    state,
    reason: undefined,
    status: undefined,
    ...more,
});

const facts = (machine: LocalMachineState | undefined, more: Partial<JourneyFacts> = {}): JourneyFacts => ({
    machine,
    folder: undefined,
    name: `shop`,
    signingIn: false,
    withSignIn: false,
    ...more,
});

const standings = (given: JourneyFacts) => journeyOf(given).map((each) => `${each.key}:${each.state}`);

describe(`a folder's way to an agent`, () => {
    it(`starts with the sign-in for a reader nobody has signed in, the press that opens the browser`, () => {
        const steps = journeyOf(facts({ state: `signedOut` }, { withSignIn: true }));
        expect(steps.map((each) => [each.title, each.state, each.note])).toEqual([
            [`Sign in`, `current`, `Opens your browser`],
            [`Get this computer's sandbox ready`, `todo`, `Set up once, then kept for all your folders`],
            [`Copy shop in`, `todo`, `Your folder stays where it is`],
        ]);
        // In the browser: the sign-in is under way, finished there.
        expect(journeyOf(facts({ state: `signedOut` }, { withSignIn: true, signingIn: true }))[0]).toMatchObject({ state: `running`, note: `Finish in your browser` });
    });

    it(`ticks the sign-in the moment the browser hands back, the sandbox next`, () => {
        expect(standings(facts({ state: `signedIn` }, { withSignIn: true, folder: folderAt(`queued`) }))).toEqual([`signIn:done`, `sandbox:running`, `copy:todo`]);
    });

    it(`leaves the sign-in out for a reader who was signed in already`, () => {
        expect(standings(facts({ state: `creating`, phase: undefined, step: undefined, percent: 30 }))).toEqual([`sandbox:running`, `copy:todo`]);
        expect(journeyOf(facts({ state: `creating`, phase: undefined, step: undefined, percent: 30 }))[0]?.note).toBe(`Setting up, 30%`);
    });

    it(`says a stopped sandbox is started for the folder, and a start that failed as failed`, () => {
        expect(journeyOf(facts({ state: `stopped` }))[0]).toMatchObject({ state: `todo`, note: `Stopped. Intentic starts it for you` });
        expect(journeyOf(facts({ state: `starting` }))[0]).toMatchObject({ state: `running`, note: `Starting it` });
        expect(journeyOf(facts({ state: `stopped`, reason: `no` }))[0]).toMatchObject({ state: `failed`, note: `Couldn't start` });
    });

    it(`waits on the reader where the sandbox does`, () => {
        expect(journeyOf(facts({ state: `needsDocker`, reason: `notRunning` }))[0]).toMatchObject({ state: `attention`, note: `Waiting for Docker to start` });
        expect(journeyOf(facts({ state: `waiting`, for: `consent` }))[0]).toMatchObject({ state: `attention`, note: `This PC needs a one-time setup first` });
        expect(journeyOf(facts({ state: `failed`, reason: `x` }))[0]?.state).toBe(`failed`);
        expect(journeyOf(facts({ state: `gone` }))[0]?.state).toBe(`failed`);
    });

    it(`follows the copy once the sandbox is ready, and only then`, () => {
        const ready: LocalMachineState = { state: `ready` };
        expect(standings(facts(ready, { folder: folderAt(`attaching`) }))).toEqual([`sandbox:done`, `copy:running`]);
        expect(standings(facts(ready, { folder: folderAt(`copying`) }))).toEqual([`sandbox:done`, `copy:running`]);
        expect(standings(facts(ready, { folder: folderAt(`copying`, { status: `paused` }) }))).toEqual([`sandbox:done`, `copy:attention`]);
        expect(standings(facts(ready, { folder: folderAt(`failed`) }))).toEqual([`sandbox:done`, `copy:failed`]);
        expect(standings(facts(ready, { folder: folderAt(`ready`) }))).toEqual([`sandbox:done`, `copy:done`]);
        // A folder said to be copying into a sandbox that is not up is not copying: it waits (2026-10-18).
        expect(standings(facts({ state: `stopped` }, { folder: folderAt(`copying`) }))).toEqual([`sandbox:todo`, `copy:todo`]);
    });

    it(`names the step under way: the first not done`, () => {
        expect(activeStep(journeyOf(facts({ state: `signedIn` }, { withSignIn: true })))?.key).toBe(`sandbox`);
        expect(activeStep(journeyOf(facts({ state: `ready` }, { folder: folderAt(`ready`) })))).toBeUndefined();
    });
});
