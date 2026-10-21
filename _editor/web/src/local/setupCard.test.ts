import type { LocalFolderSetup, LocalSetupState } from "../app/environments/localHost";
import { folderButtonOf, setupCardOf } from "./setupCard";

// What a folder's window says about its own sandbox, state by state: the card in its corner and the folder's button,
// each with the one press that moves it on.

const setupAt = (state: LocalSetupState, more: Partial<Pick<LocalFolderSetup, `name` | `status` | `heldBy` | `made` | `hasLog`>> = {}): LocalFolderSetup => ({
    ...state,
    name: `shop`,
    status: undefined,
    heldBy: [],
    made: false,
    hasLog: false,
    ...more,
});

const cardOf = (setup: LocalFolderSetup | undefined, more: { justReady?: boolean; signingIn?: boolean } = {}) =>
    setupCardOf({ setup, justReady: more.justReady ?? false, signingIn: more.signingIn });

describe(`the folder's card`, () => {
    it(`is not there for a folder nobody asked a sandbox for`, () => {
        expect(cardOf(undefined)).toBeUndefined();
    });

    it(`asks a reader nobody has signed in to sign in, with no house going up for that press`, () => {
        const card = cardOf(setupAt({ state: `signedOut` }));
        expect(card).toMatchObject({ tone: `waiting`, title: `Sign in to make shop's sandbox`, actions: [`signIn`, `dismiss`], picture: false, key: `signedOut` });
        expect(cardOf(setupAt({ state: `signedOut` }), { signingIn: true })).toMatchObject({ actions: [`signInAgain`], key: `signingIn` });
        expect(card?.steps.map((each) => each.key)).toEqual([`signIn`, `sandbox`, `copy`]);
    });

    it(`draws the house by the setup's real phases, and says how far`, () => {
        const card = cardOf(setupAt({ state: `creating`, phase: `starting-sandbox`, step: `starting sandbox`, percent: 40 }));
        expect(card).toMatchObject({ tone: `working`, stage: `walls`, percent: 40, step: `starting sandbox`, title: `Making shop's sandbox`, actions: [] });
        // The folder's link comes before the public address's checks: the copy is moving in while they run.
        expect(cardOf(setupAt({ state: `creating`, phase: `desktop-sync`, step: undefined, percent: 70 }))?.stage).toBe(`lit`);
        expect(cardOf(setupAt({ state: `creating`, phase: `verifying`, step: undefined, percent: 80 }))?.stage).toBe(`moving`);
    });

    it(`says a folder waiting its turn behind another folder's setup, and who goes first`, () => {
        expect(cardOf(setupAt({ state: `queued`, behind: `notes` }))).toMatchObject({ title: `Waiting for notes's sandbox`, key: `behind` });
        expect(cardOf(setupAt({ state: `queued`, behind: undefined }))).toMatchObject({ tone: `working`, key: `queued`, actions: [] });
    });

    it(`starts Docker on the reader's press, never by itself`, () => {
        expect(cardOf(setupAt({ state: `needsDocker`, reason: `notRunning` }))?.actions).toEqual([`startDocker`, `details`]);
        expect(cardOf(setupAt({ state: `needsDocker`, reason: `notInstalled` }))?.actions).toEqual([`details`, `dismiss`]);
    });

    it(`asks for what this computer needs, where it can be answered`, () => {
        // This PC's own setup is Devices'.
        expect(cardOf(setupAt({ state: `waiting`, for: `consent`, needs: [] }))?.actions).toEqual([`details`, `dismiss`]);
        // What the setup's first pass found is a yes on the card itself.
        const asked = cardOf(setupAt({ state: `waiting`, for: `consent`, needs: [`Turn on WSL`] }));
        expect(asked).toMatchObject({ actions: [`consent`, `dismiss`] });
        expect(asked?.detail).toContain(`Turn on WSL`);
        expect(cardOf(setupAt({ state: `waiting`, for: `restart`, needs: [] }))?.actions).toEqual([`restart`, `dismiss`]);
        expect(cardOf(setupAt({ state: `waiting`, for: `signOut`, needs: [] }))?.actions).toEqual([`signOut`, `dismiss`]);
    });

    it(`follows the copy, and says why a paused one waits`, () => {
        expect(cardOf(setupAt({ state: `copying` }, { made: true }))).toMatchObject({ tone: `working`, stage: `moving`, detail: `Getting the sandbox ready for this folder…` });
        expect(cardOf(setupAt({ state: `copying` }, { made: true, status: `staging-beta` }))?.detail).toContain(`Agents can start once the first copy is in`);
        const paused = cardOf(setupAt({ state: `copying` }, { made: true, status: `paused`, heldBy: [`low-disk`] }));
        expect(paused).toMatchObject({ tone: `waiting`, actions: [`open`] });
        expect(paused?.detail).toContain(`nearly full`);
    });

    it(`offers to try again after a failed setup, and the sandbox itself after a sync that never started`, () => {
        expect(cardOf(setupAt({ state: `failed`, reason: `no` }, { hasLog: true }))).toMatchObject({ tone: `failed`, detail: `no`, actions: [`retry`, `log`, `dismiss`] });
        expect(cardOf(setupAt({ state: `failed`, reason: `no` }))?.actions).toEqual([`retry`, `dismiss`]);
        expect(cardOf(setupAt({ state: `failed`, reason: `no` }, { made: true }))).toMatchObject({ title: `shop isn't syncing to its sandbox`, actions: [`open`, `dismiss`] });
    });

    it(`says the folder is in for a moment, and nothing after`, () => {
        expect(cardOf(setupAt({ state: `ready` }, { made: true }), { justReady: true })).toMatchObject({ tone: `ready`, stage: `home`, actions: [`open`] });
        expect(cardOf(setupAt({ state: `ready` }, { made: true }))).toBeUndefined();
    });
});

describe(`the folder's button`, () => {
    it(`asks, opens, or says how far`, () => {
        expect(folderButtonOf({ hasSandbox: false, setup: undefined })).toMatchObject({ press: `ask`, label: `Work on this with an agent` });
        expect(folderButtonOf({ hasSandbox: true, setup: undefined })).toMatchObject({ press: `open` });
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `creating`, phase: undefined, step: undefined, percent: 42 }) })).toEqual({
            label: `Making this folder's sandbox (42%)`,
            busy: true,
            press: `card`,
        });
        expect(folderButtonOf({ hasSandbox: true, setup: setupAt({ state: `copying` }, { made: true }) })).toMatchObject({ label: `Copying your folder…`, busy: true });
        expect(folderButtonOf({ hasSandbox: true, setup: setupAt({ state: `ready` }, { made: true }) })).toMatchObject({ press: `open` });
    });

    it(`is the one thing the setup is stopped on, where there is one`, () => {
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `signedOut` }) })).toMatchObject({ press: `signIn`, busy: false });
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `signedOut` }), signingIn: true })).toMatchObject({ press: `card`, busy: true });
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `needsDocker`, reason: `notRunning` }) })).toMatchObject({ press: `startDocker` });
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `waiting`, for: `consent`, needs: [] }) })).toMatchObject({
            press: `details`,
            label: `Set this computer up for agents`,
        });
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `failed`, reason: `x` }) })).toMatchObject({ press: `card`, busy: false });
    });
});
