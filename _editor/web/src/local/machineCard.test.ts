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

    it(`says the folder waiting in this window under whatever the sandbox is doing`, () => {
        const card = machineCardOf(facts(at({ state: `creating`, phase: undefined, step: undefined, percent: 5 }), folderAt(`queued`)));
        expect(card?.folderNote).toBe(`shop goes in as soon as it's ready.`);
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
