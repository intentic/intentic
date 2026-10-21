import type { LocalFolderSetup, LocalSetupState } from "../../app/environments/localHost";
import { activeStep, type JourneyFacts, journeyOf } from "./journey";

// A folder's way to an agent, step by step: what each state of the folder's own sandbox and of its copy says about the
// sign-in, the sandbox and the copy, before the press and while it goes (the folder's page for it).

const setupAt = (state: LocalSetupState, more: Partial<Pick<LocalFolderSetup, `name` | `status` | `heldBy` | `made` | `hasLog`>> = {}): LocalFolderSetup => ({
    ...state,
    name: `shop`,
    status: undefined,
    heldBy: [],
    made: false,
    hasLog: false,
    startedAt: undefined,
    ...more,
});

const facts = (setup: LocalFolderSetup | undefined, more: Partial<JourneyFacts> = {}): JourneyFacts => ({
    setup,
    signedIn: true,
    name: `shop`,
    signingIn: false,
    withSignIn: false,
    ...more,
});

const standings = (given: JourneyFacts) => journeyOf(given).map((each) => `${each.key}:${each.state}`);

describe(`a folder's way to an agent`, () => {
    it(`starts with the sign-in for a reader nobody has signed in, the press that opens the browser`, () => {
        const before = journeyOf(facts(undefined, { signedIn: false, withSignIn: true }));
        expect(before.map((each) => [each.title, each.state, each.note])).toEqual([
            [`Sign in`, `current`, `Opens your browser`],
            [`Create its sandbox`, `todo`, `On this computer`],
            [`Copy shop in`, `todo`, `Your folder stays where it is`],
        ]);
        // In the browser: the sign-in is under way, finished there.
        expect(journeyOf(facts(setupAt({ state: `signedOut` }), { withSignIn: true, signingIn: true }))[0]).toMatchObject({
            state: `running`,
            note: `Finish in your browser`,
        });
    });

    it(`ticks the sign-in the moment the browser hands back, the sandbox next`, () => {
        expect(standings(facts(setupAt({ state: `signedIn` }), { withSignIn: true }))).toEqual([`signIn:done`, `sandbox:running`, `copy:todo`]);
    });

    it(`leaves the sign-in out for a reader who was signed in already`, () => {
        const creating = setupAt({ state: `creating`, phase: undefined, step: undefined, percent: 30, left: undefined });
        expect(standings(facts(creating))).toEqual([`sandbox:running`, `copy:todo`]);
        expect(journeyOf(facts(creating))[0]?.note).toBe(`30%`);
    });

    it(`says a folder waiting behind another folder's setup is next`, () => {
        expect(journeyOf(facts(setupAt({ state: `queued`, behind: `notes` })))[0]).toMatchObject({ state: `running`, note: `Next, after another folder's` });
    });

    it(`waits on the reader where the setup does`, () => {
        expect(journeyOf(facts(setupAt({ state: `needsDocker`, reason: `notRunning` })))[0]).toMatchObject({ state: `attention`, note: `Waiting for Docker to start` });
        expect(journeyOf(facts(setupAt({ state: `waiting`, for: `consent`, needs: [] })))[0]).toMatchObject({
            state: `attention`,
            note: `This PC needs a one-time setup first`,
        });
        expect(journeyOf(facts(setupAt({ state: `failed`, reason: `x` })))[0]?.state).toBe(`failed`);
    });

    it(`follows the copy once the sandbox is made, and only then`, () => {
        expect(standings(facts(setupAt({ state: `copying` }, { made: true })))).toEqual([`sandbox:done`, `copy:running`]);
        expect(standings(facts(setupAt({ state: `copying` }, { made: true, status: `paused` })))).toEqual([`sandbox:done`, `copy:attention`]);
        // Made, and its folder never started syncing: the copy failed, not the sandbox.
        expect(standings(facts(setupAt({ state: `failed`, reason: `x` }, { made: true })))).toEqual([`sandbox:done`, `copy:failed`]);
        expect(standings(facts(setupAt({ state: `ready` }, { made: true })))).toEqual([`sandbox:done`, `copy:done`]);
        // Nothing is copied before the sandbox is up: the folder waits.
        expect(standings(facts(setupAt({ state: `failed`, reason: `x` })))).toEqual([`sandbox:failed`, `copy:todo`]);
    });

    it(`names the step under way: the first not done`, () => {
        expect(activeStep(journeyOf(facts(setupAt({ state: `signedIn` }), { withSignIn: true })))?.key).toBe(`sandbox`);
        expect(activeStep(journeyOf(facts(setupAt({ state: `ready` }, { made: true }))))).toBeUndefined();
    });
});
