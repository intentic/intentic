import type { LocalFolderSandbox, LocalMachineSandbox, LocalMachineState } from "../app/environments/localHost";
import { type CardFacts, folderButtonOf, machineCardOf } from "./machineCard";

// What a local window says about this computer's sandbox and its folder: every state the app can report, the card it
// comes to (or none), the one thing it offers to do, and what the folder's own button says.

const at = (state: LocalMachineState, more: Partial<Pick<LocalMachineSandbox, `name` | `waiting` | `hasLog`>> = {}): LocalMachineSandbox => ({
    name: `ada-laptop sandbox`,
    waiting: 0,
    hasLog: false,
    ...state,
    ...more,
});

const facts = (machine: LocalMachineSandbox | undefined, folder?: LocalFolderSandbox, more: Partial<CardFacts> = {}): CardFacts => ({
    machine,
    folder,
    justReady: false,
    folderJustReady: false,
    ...more,
});

const folderAt = (state: LocalFolderSandbox[`state`], more: Partial<LocalFolderSandbox> = {}): LocalFolderSandbox => ({
    name: `shop`,
    state,
    reason: undefined,
    status: undefined,
    ...more,
});

describe(`the card of this computer's sandbox`, () => {
    it(`says nothing before the app has, nor about a sandbox that is simply ready`, () => {
        expect(machineCardOf(facts(undefined))).toBeUndefined();
        expect(machineCardOf(facts(at({ state: `ready` })))).toBeUndefined();
    });

    it(`goes up as its setup goes, the house standing no further than its lights before a folder moves in`, () => {
        const pulling = machineCardOf(facts(at({ state: `creating`, phase: `pulling-image`, step: `downloading the image`, percent: 40 })));
        expect(pulling).toMatchObject({ about: `machine`, tone: `working`, stage: `ground`, percent: 40, step: `downloading the image`, actions: [] });
        expect(pulling?.title).toBe(`Setting up this computer's sandbox`);
        expect(pulling?.detail).toBe(`Laying the foundation`);
        // The setup's own folder step is this machine's enrolment, not a folder's copy: the house is lit, not lived in.
        expect(machineCardOf(facts(at({ state: `creating`, phase: `desktop-sync`, step: undefined, percent: 90 })))).toMatchObject({ stage: `lit` });
        expect(machineCardOf(facts(at({ state: `creating`, phase: `connecting-machine`, step: undefined, percent: 95 })))).toMatchObject({ stage: `lit` });
        expect(machineCardOf(facts(at({ state: `interrupted` })))).toMatchObject({ tone: `working`, key: `creating` });
    });

    it(`offers the one thing that moves each stop on`, () => {
        const offered = (machine: LocalMachineSandbox) => machineCardOf(facts(machine))?.actions;
        expect(offered(at({ state: `needsDocker`, reason: `notRunning` }))).toEqual([`startDocker`, `details`]);
        expect(offered(at({ state: `needsDocker`, reason: `notInstalled` }))).toEqual([`details`]);
        expect(offered(at({ state: `needsDocker`, reason: `notAllowed` }))).toEqual([`details`]);
        expect(offered(at({ state: `waiting`, for: `consent` }))).toEqual([`details`]);
        expect(offered(at({ state: `failed`, reason: `docker refused` }))).toEqual([`retry`]);
        expect(offered(at({ state: `failed`, reason: `docker refused` }, { hasLog: true }))).toEqual([`retry`, `log`]);
        expect(offered(at({ state: `stopped` }))).toEqual([`start`]);
        expect(offered(at({ state: `gone` }))).toEqual([`recreate`]);
    });

    it(`says a failure in the setup's own words`, () => {
        expect(machineCardOf(facts(at({ state: `failed`, reason: `the platform refused the setup code.` })))).toMatchObject({
            tone: `failed`,
            title: `This computer's sandbox wasn't set up`,
            detail: `the platform refused the setup code.`,
        });
    });

    // Nothing is under way before sign-in: the card is for a reader whose folder waits for it.
    it(`asks for a sign-in only where a folder waits for one`, () => {
        expect(machineCardOf(facts(at({ state: `signedOut` })))).toBeUndefined();
        expect(machineCardOf(facts(at({ state: `signedOut` }, { waiting: 1 })))).toMatchObject({ actions: [`signIn`], tone: `waiting` });
        expect(machineCardOf(facts(at({ state: `signedOut` }), folderAt(`queued`)))).toMatchObject({ actions: [`signIn`] });
    });

    // The reader is in the browser signing in: the card says to finish there, and offers the page again, not a sign-in.
    it(`says to finish signing in while the browser has it, rather than asking again`, () => {
        expect(machineCardOf(facts(at({ state: `signedOut` }), folderAt(`queued`), { signingIn: true }))).toMatchObject({
            title: `Finish signing in in your browser`,
            tone: `working`,
            actions: [`signInAgain`],
            key: `signingIn`,
        });
        expect(folderButtonOf({ hasSandbox: false, machine: at({ state: `signedOut` }), folder: folderAt(`queued`), signingIn: true })).toEqual({
            label: `Waiting for you to sign in…`,
            busy: true,
            press: `card`,
        });
        // Once the app has heard who signed in, the sandbox's own progress says the rest.
        expect(machineCardOf(facts(at({ state: `creating`, phase: undefined, step: undefined, percent: 5 }), folderAt(`queued`), { signingIn: true }))?.key).toBe(
            `creating`,
        );
    });

    it(`ticks off the steps of the folder waiting in this window under whatever the sandbox is doing`, () => {
        const card = machineCardOf(facts(at({ state: `creating`, phase: undefined, step: undefined, percent: 5 }), folderAt(`queued`), { withSignIn: true }));
        expect(card?.steps?.map((each) => [each.key, each.state])).toEqual([
            [`signIn`, `done`],
            [`sandbox`, `running`],
            [`copy`, `todo`],
        ]);
        // A card about the sandbox alone, with no folder of this window's on its way, lists none.
        expect(machineCardOf(facts(at({ state: `creating`, phase: undefined, step: undefined, percent: 5 })))?.steps).toBeUndefined();
    });

    // The report this came from (2026-10-18): the house went up, and the folder was carried into it, over a card that
    // only asked the reader to sign in.
    it(`draws no house while the reader is still to sign in, and draws it from the moment they have`, () => {
        expect(machineCardOf(facts(at({ state: `signedOut` }), folderAt(`queued`), { signingIn: true }))).toMatchObject({ picture: false, stage: `plan` });
        expect(machineCardOf(facts(at({ state: `signedOut` }), folderAt(`queued`)))?.picture).toBe(false);
        const back = machineCardOf(facts(at({ state: `signedIn` }), folderAt(`queued`)));
        expect(back).toMatchObject({ picture: true, tone: `working`, title: `You're signed in`, actions: [], key: `signedIn` });
        expect(back?.steps?.map((each) => each.state)).toEqual([`done`, `running`, `todo`]);
    });

    // Signed in, the sandbox found stopped and a folder waiting: the app starts it, and the card says so rather than
    // asking for a press (the app's machine_sandbox.rs `starts_by_itself`).
    it(`says a stopped sandbox is starting, and why it did not start when it did not`, () => {
        expect(machineCardOf(facts(at({ state: `starting` }), folderAt(`queued`)))).toMatchObject({
            tone: `working`,
            stage: `roof`,
            title: `Starting this computer's sandbox`,
            actions: [],
            key: `starting`,
        });
        expect(machineCardOf(facts(at({ state: `stopped` })))).toMatchObject({ tone: `waiting`, stage: `roof`, actions: [`start`], key: `stopped` });
        expect(machineCardOf(facts(at({ state: `stopped`, reason: `port 443 is taken` })))).toMatchObject({
            tone: `failed`,
            title: `This computer's sandbox didn't start`,
            detail: `port 443 is taken`,
            actions: [`start`],
            key: `startFailed`,
        });
        expect(folderButtonOf({ hasSandbox: false, machine: at({ state: `starting` }), folder: folderAt(`queued`) })).toEqual({
            label: `Starting this computer's sandbox…`,
            busy: true,
            press: `card`,
        });
        expect(folderButtonOf({ hasSandbox: false, machine: at({ state: `signedIn` }), folder: folderAt(`queued`) })).toEqual({
            label: `Getting ready…`,
            busy: true,
            press: `card`,
        });
    });

    it(`says for a moment that it is ready, while this window watched it get there`, () => {
        expect(machineCardOf(facts(at({ state: `ready` }), undefined, { justReady: true }))).toMatchObject({ tone: `ready`, about: `machine`, key: `ready` });
    });

    it(`keys each state apart, so a fold holds for one thing only`, () => {
        const key = (machine: LocalMachineSandbox) => machineCardOf(facts(machine))?.key;
        expect(key(at({ state: `needsDocker`, reason: `notRunning` }))).not.toBe(key(at({ state: `needsDocker`, reason: `notInstalled` })));
        expect(key(at({ state: `failed`, reason: `x` }))).toBe(`failed`);
    });
});

describe(`the card of this window's folder, once the sandbox is up`, () => {
    const ready = at({ state: `ready` });

    it(`follows the folder in: added, copied, then in for a moment with the way to its sandbox`, () => {
        expect(machineCardOf(facts(ready, folderAt(`attaching`)))).toMatchObject({ about: `folder`, tone: `working`, stage: `moving` });
        expect(machineCardOf(facts(ready, folderAt(`copying`)))).toMatchObject({ detail: `Getting the sandbox ready for this folder…` });
        expect(machineCardOf(facts(ready, folderAt(`copying`, { status: `scanning` })))).toMatchObject({ title: `Copying shop into this computer's sandbox` });
        expect(machineCardOf(facts(ready, folderAt(`ready`), { folderJustReady: true }))).toMatchObject({ tone: `ready`, stage: `home`, actions: [`open`] });
        expect(machineCardOf(facts(ready, folderAt(`ready`)))).toBeUndefined();
    });

    it(`says why the agent turned it down, and offers to try again`, () => {
        expect(machineCardOf(facts(ready, folderAt(`failed`, { reason: `That folder is already attached.` })))).toMatchObject({
            tone: `failed`,
            detail: `That folder is already attached.`,
            actions: [`retryFolder`],
        });
    });

    it(`says a paused first copy is waiting, and follows it back to copying when it resumes`, () => {
        expect(machineCardOf(facts(ready, folderAt(`copying`, { status: `paused` })))).toMatchObject({
            tone: `waiting`,
            stage: `lit`,
            title: `Copying shop is paused`,
            detail: `Open the sandbox's Devices page to resume file syncing.`,
            actions: [`open`],
            key: `folder:paused`,
        });
        expect(machineCardOf(facts(ready, folderAt(`copying`, { status: `scanning` })))).toMatchObject({ tone: `working`, key: `folder:copying` });
    });
});

describe(`the folder's own button`, () => {
    const creating = at({ state: `creating`, phase: undefined, step: undefined, percent: 42 });

    it(`asks, for a folder with no sandbox and nothing under way`, () => {
        expect(folderButtonOf({ hasSandbox: false, machine: creating, folder: undefined })).toEqual({ label: `Work on this with an agent`, busy: false, press: `ask` });
    });

    it(`waits on this computer's sandbox, saying how far it is while it is made`, () => {
        expect(folderButtonOf({ hasSandbox: false, machine: creating, folder: folderAt(`queued`) })).toEqual({
            label: `Waiting for this computer's sandbox (42%)`,
            busy: true,
            press: `card`,
        });
        // Picked up after a quit: under way again, with nothing to ask of anyone.
        expect(folderButtonOf({ hasSandbox: false, machine: at({ state: `interrupted` }), folder: folderAt(`queued`) })).toEqual({
            label: `Waiting for this computer's sandbox`,
            busy: true,
            press: `card`,
        });
        // Before the app has said anything at all.
        expect(folderButtonOf({ hasSandbox: false, machine: undefined, folder: folderAt(`queued`) })).toEqual({
            label: `Waiting for this computer's sandbox`,
            busy: true,
            press: `card`,
        });
    });

    // Asleep is the keeper's doing, not a stop on the reader: no card asks for a Start (2026-10-19, a reader back from a
    // workspace that had just woken it was asked to start it), and the folder's own button still opens its sandbox,
    // which wakes it.
    it(`asks nothing of a sandbox that is only asleep`, () => {
        const asleep = at({ state: `asleep` });
        expect(machineCardOf(facts(asleep))).toBeUndefined();
        expect(machineCardOf(facts(asleep, folderAt(`ready`)))).toBeUndefined();
        expect(folderButtonOf({ hasSandbox: true, machine: asleep, folder: undefined })).toEqual({ label: `Open this folder's sandbox`, busy: false, press: `open` });
        // A folder on its way in wakes it by itself (the app's machine_sandbox.rs `wakes_by_itself`): said so, nothing to press.
        expect(machineCardOf(facts(asleep, folderAt(`copying`)))).toMatchObject({
            tone: `working`,
            title: `Waking this computer's sandbox`,
            actions: [],
            key: `waking`,
        });
        expect(folderButtonOf({ hasSandbox: true, machine: asleep, folder: folderAt(`queued`) })).toEqual({
            label: `Waiting for this computer's sandbox`,
            busy: true,
            press: `card`,
        });
        // A copy held still by a pause leaves it asleep: waking it is the reader's press.
        const held = folderAt(`copying`, { status: `paused` });
        expect(machineCardOf(facts(asleep, held))).toMatchObject({ tone: `waiting`, title: `This computer's sandbox is asleep`, actions: [`start`], key: `asleep` });
        expect(folderButtonOf({ hasSandbox: true, machine: asleep, folder: held })).toEqual({ label: `Start`, busy: false, press: `start` });
        // A folder turned down is said as such, asleep or not.
        expect(machineCardOf(facts(asleep, folderAt(`failed`, { reason: `no` })))).toMatchObject({ about: `folder`, key: `folder:failed` });
    });

    // The report this came from: a PC waiting for its own setup said "Waiting for this computer's sandbox", and the
    // press unfolded a card that was already open, so the one button in the window did nothing at all.
    it(`is the next step itself, wherever the sandbox is stopped on the reader rather than on itself`, () => {
        const next = (state: LocalMachineState) => folderButtonOf({ hasSandbox: false, machine: at(state), folder: folderAt(`queued`) });
        // This PC's own setup, Docker missing, Docker turned away: all of them are This computer, named by what it is for.
        expect(next({ state: `waiting`, for: `consent` })).toEqual({ label: `Set this computer up for agents`, busy: false, press: `details` });
        expect(next({ state: `needsDocker`, reason: `notInstalled` })).toEqual({ label: `Set this computer up for agents`, busy: false, press: `details` });
        expect(next({ state: `needsDocker`, reason: `notAllowed` }).press).toBe(`details`);
        // Docker is started on the reader's press, so the button is that press rather than a word about waiting.
        expect(next({ state: `needsDocker`, reason: `notRunning` })).toEqual({ label: `Start Docker`, busy: false, press: `startDocker` });
        expect(next({ state: `signedOut` })).toEqual({ label: `Sign in`, busy: false, press: `signIn` });
        expect(next({ state: `failed`, reason: `docker refused` })).toEqual({ label: `Try again`, busy: false, press: `retry` });
        expect(next({ state: `stopped` })).toEqual({ label: `Start`, busy: false, press: `start` });
        expect(next({ state: `gone` })).toEqual({ label: `Set it up again`, busy: false, press: `recreate` });
    });

    it(`copies, then opens the sandbox once the folder is in`, () => {
        const ready = at({ state: `ready` });
        // Attached means the folder has its sandbox already: the copy still leads the button until it is in.
        expect(folderButtonOf({ hasSandbox: true, machine: ready, folder: folderAt(`copying`) })).toEqual({ label: `Copying your folder…`, busy: true, press: `card` });
        expect(folderButtonOf({ hasSandbox: true, machine: ready, folder: folderAt(`ready`) })).toEqual({ label: `Open this folder's sandbox`, busy: false, press: `open` });
    });

    it(`stops spinning while the folder's first copy is paused`, () => {
        expect(folderButtonOf({ hasSandbox: true, machine: at({ state: `ready` }), folder: folderAt(`copying`, { status: `paused` }) })).toEqual({
            label: `Copying is paused`,
            busy: false,
            press: `card`,
        });
    });

    it(`opens a sandbox of the folder's own from before, whatever this computer's is doing`, () => {
        expect(folderButtonOf({ hasSandbox: true, machine: at({ state: `failed`, reason: `x` }), folder: undefined }).press).toBe(`open`);
    });

    it(`brings back the card of a folder turned down`, () => {
        expect(folderButtonOf({ hasSandbox: false, machine: at({ state: `ready` }), folder: folderAt(`failed`) })).toEqual({
            label: `Couldn't add this folder`,
            busy: false,
            press: `card`,
        });
    });
});
