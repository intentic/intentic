import type { LocalFolderSetup, LocalProjectPreview, LocalSetupState } from "../../app/environments/localHost";
import { folderButtonOf, setupBadgeOf, setupViewOf } from "./setupView";

// What a folder's window says about its own sandbox, state by state: its page before the press and at every step after
// it, the rail tile's mark for a reader who left the page, and the folder's own button in Files.

const setupAt = (state: LocalSetupState, more: Partial<Pick<LocalFolderSetup, `name` | `status` | `heldBy` | `made` | `hasLog` | `madeAt` | `copy`>> = {}): LocalFolderSetup => ({
    ...state,
    name: `shop`,
    status: undefined,
    heldBy: [],
    made: false,
    hasLog: false,
    startedAt: undefined,
    ...more,
});

const NEW: LocalProjectPreview = {
    kind: `new`,
    name: `shop`,
    path: `C:\\code\\shop`,
    files: 3,
    bytes: 355,
    more: false,
    large: false,
    cautions: [],
    signedIn: true,
    seconds: 169,
};

const viewOf = (setup: LocalFolderSetup | undefined, more: { preview?: LocalProjectPreview; signingIn?: boolean } = {}) =>
    setupViewOf({ setup, preview: more.preview, name: `shop`, path: `C:\\code\\shop`, signingIn: more.signingIn });

describe(`the page before the press`, () => {
    it(`says nothing while the app weighs the folder, nor for one that has its sandbox already`, () => {
        expect(viewOf(undefined)).toBeUndefined();
        expect(viewOf(undefined, { preview: { kind: `existing` } })).toBeUndefined();
    });

    it(`asks once, with the steps that follow, the sign-in among them only where nobody is signed in`, () => {
        const signedIn = viewOf(undefined, { preview: NEW });
        expect(signedIn).toMatchObject({ tone: `asking`, hero: { kind: `house`, stage: `plan` }, actions: [`create`], carriesOn: false });
        expect(signedIn?.steps.map((each) => each.key)).toEqual([`sandbox`, `copy`]);
        const signedOut = viewOf(undefined, { preview: { ...NEW, signedIn: false } });
        expect(signedOut?.actions).toEqual([`signInCreate`]);
        expect(signedOut?.steps.map((each) => [each.key, each.state])).toEqual([
            [`signIn`, `current`],
            [`sandbox`, `todo`],
            [`copy`, `todo`],
        ]);
    });

    it(`says why a folder cannot have one, and offers nothing to press`, () => {
        expect(viewOf(undefined, { preview: { kind: `refused`, refusal: { kind: `disk` } } })).toMatchObject({
            tone: `failed`,
            title: `This folder can't have a sandbox`,
            detail: `C:\\code\\shop is a whole disk. Open the folder of one project in it.`,
            actions: [],
            steps: [],
        });
        expect(viewOf(undefined, { preview: { kind: `document` } })).toMatchObject({ tone: `failed`, title: `Open the folder first`, actions: [] });
    });
});

describe(`the page after the press`, () => {
    it(`asks a reader nobody has signed in to sign in, with a mark rather than a house for that press`, () => {
        const view = viewOf(setupAt({ state: `signedOut` }));
        expect(view).toMatchObject({ tone: `asking`, hero: { kind: `mark`, icon: `sign-in` }, title: `Sign in to continue`, actions: [`signIn`, `dismiss`] });
        expect(viewOf(setupAt({ state: `signedOut` }), { signingIn: true })).toMatchObject({
            tone: `working`,
            title: `Finish signing in in your browser`,
            actions: [`signInAgain`, `dismiss`],
            carriesOn: true,
        });
        expect(view?.steps.map((each) => each.key)).toEqual([`signIn`, `sandbox`, `copy`]);
        // Back from the browser, the account on its way: the sandbox is next, and nothing is asked of the reader.
        expect(viewOf(setupAt({ state: `signedIn` }))).toMatchObject({ tone: `working`, title: `You're signed in`, actions: [] });
    });

    it(`draws the house by the setup's real phases, and says how far and how long is left`, () => {
        const view = viewOf(setupAt({ state: `creating`, phase: `starting-sandbox`, step: `starting sandbox`, percent: 40, left: 90 }));
        expect(view).toMatchObject({
            tone: `working`,
            hero: { kind: `house`, stage: `walls` },
            percent: 40,
            step: `starting sandbox`,
            left: 90,
            title: `Making shop's sandbox`,
            actions: [],
            carriesOn: true,
        });
        // The folder's link comes before the public address's checks: the copy is moving in while they run.
        expect(viewOf(setupAt({ state: `creating`, phase: `desktop-sync`, step: undefined, percent: 70, left: undefined }))?.hero).toEqual({ kind: `house`, stage: `lit` });
        expect(viewOf(setupAt({ state: `creating`, phase: `verifying`, step: undefined, percent: 80, left: undefined }))?.hero).toEqual({ kind: `house`, stage: `moving` });
    });

    it(`says a folder waiting its turn behind another folder's setup, and who goes first`, () => {
        expect(viewOf(setupAt({ state: `queued`, behind: `notes` }))).toMatchObject({ title: `Waiting for notes's sandbox`, actions: [`dismiss`] });
        expect(viewOf(setupAt({ state: `queued`, behind: undefined }))).toMatchObject({ tone: `working`, actions: [] });
    });

    it(`starts Docker on the reader's press, never by itself`, () => {
        expect(viewOf(setupAt({ state: `needsDocker`, reason: `notRunning` }))).toMatchObject({ tone: `waiting`, actions: [`startDocker`, `details`], carriesOn: false });
        expect(viewOf(setupAt({ state: `needsDocker`, reason: `notInstalled` }))?.actions).toEqual([`details`, `dismiss`]);
    });

    it(`asks for what this computer needs, where it can be answered`, () => {
        // This PC's own setup is Devices'.
        expect(viewOf(setupAt({ state: `waiting`, for: `consent`, needs: [] }))?.actions).toEqual([`details`, `dismiss`]);
        // What the setup's first pass found is a yes on the page itself.
        const asked = viewOf(setupAt({ state: `waiting`, for: `consent`, needs: [`Turn on WSL`] }));
        expect(asked).toMatchObject({ actions: [`consent`, `dismiss`] });
        expect(asked?.detail).toContain(`Turn on WSL`);
        expect(viewOf(setupAt({ state: `waiting`, for: `restart`, needs: [] }))?.actions).toEqual([`restart`, `dismiss`]);
        expect(viewOf(setupAt({ state: `waiting`, for: `signOut`, needs: [] }))?.actions).toEqual([`signOut`, `dismiss`]);
    });

    it(`follows the copy, and says why a paused one waits`, () => {
        // Before the sync's first word: a connection on its way, measured from nothing, what it carries said from the ask.
        expect(viewOf(setupAt({ state: `copying` }, { made: true, madeAt: 7 }), { preview: NEW })).toMatchObject({
            tone: `working`,
            hero: { kind: `house`, stage: `moving` },
            detail: `Agents can start as soon as it's in.`,
            percent: 0,
            step: `Connecting to the sandbox`,
            measure: `3 files · 355 B`,
            since: 7,
        });
        const paused = viewOf(setupAt({ state: `copying` }, { made: true, status: `paused`, heldBy: [`low-disk`] }));
        expect(paused).toMatchObject({ tone: `waiting`, actions: [`open`] });
        expect(paused?.detail).toContain(`nearly full`);
    });

    it(`calls the folder ready only once its workspace is up, saying so meanwhile with nothing to press`, () => {
        const opening = viewOf(setupAt({ state: `copying` }, { made: true, status: `opening` }));
        expect(opening).toMatchObject({ tone: `working`, title: `Opening shop's sandbox`, step: `Loading the workspace`, percent: undefined, actions: [] });
        expect(opening?.steps.at(-1)).toMatchObject({ state: `running`, note: `Loading the workspace` });
        expect(folderButtonOf({ hasSandbox: true, setup: setupAt({ state: `copying` }, { made: true, status: `opening` }) })).toMatchObject({
            label: `Opening the sandbox…`,
            busy: true,
            press: `view`,
        });
    });

    it(`offers to try again after a failed setup, and the sandbox itself after a sync that never started`, () => {
        expect(viewOf(setupAt({ state: `failed`, reason: `no` }, { hasLog: true }))).toMatchObject({ tone: `failed`, detail: `no`, actions: [`retry`, `log`, `dismiss`] });
        expect(viewOf(setupAt({ state: `failed`, reason: `no` }))?.actions).toEqual([`retry`, `dismiss`]);
        expect(viewOf(setupAt({ state: `failed`, reason: `no` }, { made: true }))).toMatchObject({ title: `shop isn't syncing to its sandbox`, actions: [`open`, `dismiss`] });
    });

    it(`says the folder is in, with the sandbox to open`, () => {
        expect(viewOf(setupAt({ state: `ready` }, { made: true }))).toMatchObject({ tone: `ready`, hero: { kind: `house`, stage: `home` }, actions: [`open`], carriesOn: false });
    });
});

describe(`the rail tile's mark`, () => {
    const badgeAt = (setup: LocalFolderSetup) => setupBadgeOf(viewOf(setup), setup);

    it(`is nothing before the press`, () => {
        expect(setupBadgeOf(viewOf(undefined, { preview: NEW }), undefined)).toBeUndefined();
    });

    it(`spins while the work goes on by itself, with how far where it is measured`, () => {
        expect(badgeAt(setupAt({ state: `creating`, phase: undefined, step: undefined, percent: 42, left: undefined }))).toEqual({ running: `42%` });
        expect(badgeAt(setupAt({ state: `copying` }, { made: true, status: `scanning` }))).toEqual({ running: `1%` });
        // Files crossing with nothing counting them (an agent older than the counts): what it does, not a figure.
        expect(badgeAt(setupAt({ state: `copying` }, { made: true, status: `staging-beta` }))).toEqual({ running: `Copying files` });
    });

    it(`asks for attention when the reader is needed, says a failure, and ticks a folder that is in`, () => {
        expect(badgeAt(setupAt({ state: `signedOut` }))).toMatchObject({ mark: `exclamation-circle`, tone: `warning`, tooltip: `Sign in to continue` });
        expect(badgeAt(setupAt({ state: `needsDocker`, reason: `notRunning` }))).toMatchObject({ mark: `exclamation-circle`, tone: `warning` });
        expect(badgeAt(setupAt({ state: `failed`, reason: `no` }))).toMatchObject({ mark: `exclamation-circle`, tone: `danger` });
        expect(badgeAt(setupAt({ state: `ready` }, { made: true }))).toMatchObject({ mark: `check` });
    });
});

describe(`the folder's button`, () => {
    it(`asks, opens, or says how far`, () => {
        expect(folderButtonOf({ hasSandbox: false, setup: undefined })).toMatchObject({ press: `ask`, label: `Work on this with an agent` });
        expect(folderButtonOf({ hasSandbox: true, setup: undefined })).toMatchObject({ press: `open` });
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `creating`, phase: undefined, step: undefined, percent: 42, left: undefined }) })).toEqual({
            label: `Making this folder's sandbox (42%)`,
            busy: true,
            press: `view`,
        });
        expect(folderButtonOf({ hasSandbox: true, setup: setupAt({ state: `copying` }, { made: true }) })).toMatchObject({ label: `Copying your folder…`, busy: true });
        expect(folderButtonOf({ hasSandbox: true, setup: setupAt({ state: `ready` }, { made: true }) })).toMatchObject({ press: `open` });
    });

    it(`offers no second sandbox for a folder another account's sandbox syncs: it says whose, and a press switches`, () => {
        expect(folderButtonOf({ hasSandbox: false, setup: undefined, otherAccount: { owner: `ada@work.example` } })).toEqual({
            label: `Sign in as ada@work.example`,
            busy: false,
            press: `switch`,
        });
        expect(folderButtonOf({ hasSandbox: false, setup: undefined, otherAccount: { owner: undefined } })).toMatchObject({ label: `Belongs to another account`, press: `switch` });
        // Its own sandbox wins: the app says so once the account it belongs to is signed in.
        expect(folderButtonOf({ hasSandbox: true, setup: undefined, otherAccount: { owner: `ada@work.example` } })).toMatchObject({ press: `open` });
    });

    it(`says what the setup waits for, and shows its page, where that is done`, () => {
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `signedOut` }) })).toEqual({ label: `Sign in to continue`, busy: false, press: `view` });
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `signedOut` }), signingIn: true })).toMatchObject({ press: `view`, busy: true });
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `needsDocker`, reason: `notRunning` }) })).toEqual({
            label: `Waiting for Docker`,
            busy: false,
            press: `view`,
        });
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `waiting`, for: `consent`, needs: [] }) })).toMatchObject({ label: `This computer needs you`, press: `view` });
        expect(folderButtonOf({ hasSandbox: false, setup: setupAt({ state: `failed`, reason: `x` }) })).toMatchObject({ press: `view`, busy: false });
    });
});
