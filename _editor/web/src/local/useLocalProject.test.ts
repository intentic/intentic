import "@intentic/testing/dom";
import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { nextTick, ref } from "vue";
import {
    LINK_HOST,
    type LocalFolderSetup,
    type LocalHost,
    type LocalProjectHost,
    type LocalProjectPreview,
    type LocalSetupState,
} from "../app/environments/localHost";

// "Work on this with an agent" in a folder's window: its own dialog, a sandbox of the folder's own under a name derived
// from the folder's, a press that never waits on it, and a card that comes back rather than a second question while
// the folder is on its way. The app is a fake host; the links a page without one sends are caught where they leave
// (desktop.ts sends them a beat apart, so the clock is walked).

const load = () => freshImport<typeof import("./useLocalProject")>("./useLocalProject", import.meta.url);

const setupOf = (state: LocalSetupState, more: Partial<Pick<LocalFolderSetup, `name` | `status` | `heldBy` | `made` | `hasLog`>> = {}): LocalFolderSetup => ({
    ...state,
    name: `My-App`,
    status: undefined,
    heldBy: [],
    made: false,
    hasLog: false,
    ...more,
});

const CREATING = setupOf({ state: `creating`, phase: `pulling-image`, step: `Download`, percent: 30 });

const NEW: LocalProjectPreview = {
    kind: `new`,
    name: `My App`,
    path: `C:\\Users\\me\\Documents\\My App`,
    files: 3,
    bytes: 355,
    more: false,
    large: false,
    cautions: [],
    signedIn: true,
};

const setup = ref<LocalFolderSetup | undefined>(undefined);

const fakeProject = (preview: LocalProjectPreview, started: Promise<`started` | `opened`> = Promise.resolve(`started`)) => {
    const asked = jest.fn(async () => preview);
    const create = jest.fn(async (_project: string) => started);
    const act = jest.fn(async (_action: string) => undefined);
    const open = jest.fn(async () => undefined);
    const project: LocalProjectHost = { preview: asked, create, setup, open, act, detailsPath: `/device` };
    const host: LocalHost = { ...LINK_HOST, native: true, project };
    window.__INTENTIC_LOCAL_HOST__ = host;
    return { asked, create, act, open };
};

let heard: string[] = [];
beforeEach(() => {
    jest.useFakeTimers();
    heard = [];
    setup.value = undefined;
    localStorage.clear();
    Object.defineProperty(document, `readyState`, { configurable: true, get: () => `complete` });
    stubGlobal(`location`, {
        get href(): string {
            return heard.at(-1) ?? ``;
        },
        set href(link: string) {
            heard.push(link);
        },
    });
});
afterEach(() => {
    jest.advanceTimersByTime(1_000);
    jest.useRealTimers();
    unstubAllGlobals();
    delete window.__INTENTIC_LOCAL_HOST__;
});

const links = (): string[] => {
    jest.advanceTimersByTime(1_000);
    return [...heard];
};

it(`asks in the window, with what the app found out about the folder`, async () => {
    fakeProject(NEW);
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.ask();
    expect({ open: flow.dialogOpen.value, preview: flow.preview.value, links: links() }).toEqual({ open: true, preview: NEW, links: [] });
});

it(`opens the sandbox a folder already has, asking nothing`, async () => {
    fakeProject({ kind: `existing` });
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.ask();
    expect({ open: flow.dialogOpen.value, links: links() }).toEqual({ open: false, links: [`intentic://local?do=sandbox`] });
});

// The folder's name in /work is the folder's own, made safe (`projectDirNameFor`): the sandbox is the folder's alone.
it(`asks for a sandbox of the folder's own under the name derived from its own, and the dialog goes at once`, async () => {
    const { create, act } = fakeProject(NEW);
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.ask();
    await flow.create();
    expect(create).toHaveBeenCalledWith(`My-App`);
    expect(act).not.toHaveBeenCalled();
    expect({ open: flow.dialogOpen.value, folded: flow.minimized.value }).toEqual({ open: false, folded: false });
});

it(`asks for the sign-in at the same press when nobody is signed in, the folder already asked for`, async () => {
    const { create, act } = fakeProject({ ...NEW, signedIn: false });
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.ask();
    await flow.create();
    expect(create).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith(`signIn`);
    expect(flow.dialogOpen.value).toBe(false);
});

it(`keeps the dialog up with the app's own reason when the folder could not be asked for`, async () => {
    fakeProject(NEW, Promise.reject(new Error(`This folder can't be used to name a folder in a sandbox.`)));
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.ask();
    await flow.create();
    expect({ open: flow.dialogOpen.value, failure: flow.failure.value, creating: flow.creating.value }).toEqual({
        open: true,
        failure: `This folder can't be used to name a folder in a sandbox.`,
        creating: false,
    });
});

it(`asks for nothing for a folder that cannot have a sandbox`, async () => {
    const { create } = fakeProject({ kind: `refused`, refusal: { kind: `disk` } });
    const flow = (await load()).useLocalProject();
    await flow.ask();
    await flow.create();
    expect(create).not.toHaveBeenCalled();
});

it(`brings back the card of a folder on its way rather than asking a second time`, async () => {
    const { asked } = fakeProject(NEW);
    setup.value = CREATING;
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    flow.fold(true);
    await flow.ask();
    expect({ open: flow.dialogOpen.value, folded: flow.minimized.value, previewed: asked.mock.calls.length }).toEqual({ open: false, folded: false, previewed: 0 });
});

// A press that asks for the card it is already looking at used to set `minimized` from false to false, and nothing on
// screen moved: the folder's button in a window whose card was open did nothing whatsoever.
it(`flashes a card asked for while it is already open, and simply unfolds a folded one`, async () => {
    fakeProject(NEW);
    setup.value = CREATING;
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await nextTick();
    expect(flow.attention.value).toBe(false);
    flow.fold(false);
    expect({ folded: flow.minimized.value, flashed: flow.attention.value }).toEqual({ folded: false, flashed: true });
    // Folded, the unfolding is answer enough.
    flow.fold(true);
    flow.fold(false);
    expect(flow.minimized.value).toBe(false);
});

it(`asks the app by link where there is no app behind the page to answer`, async () => {
    const { useLocalProject } = await load();
    await useLocalProject().ask();
    expect(links()).toEqual([`intentic://local?do=sandbox`]);
});

it(`carries the card while the folder is on its way, and says for a moment when it is in`, async () => {
    fakeProject(NEW);
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    expect(flow.card.value).toBeUndefined();
    setup.value = CREATING;
    await nextTick();
    expect(flow.card.value?.tone).toBe(`working`);
    setup.value = setupOf({ state: `copying` }, { status: `staging`, made: true });
    await nextTick();
    setup.value = setupOf({ state: `ready` }, { made: true });
    await nextTick();
    expect(flow.card.value?.tone).toBe(`ready`);
    jest.advanceTimersByTime(15_000);
    expect(flow.card.value).toBeUndefined();
});

// A fold is remembered for what the card showed, in every window: the same news stays folded, new news unfolds.
it(`remembers a fold for what it showed, and unfolds for something new`, async () => {
    fakeProject(NEW);
    setup.value = setupOf({ state: `needsDocker`, reason: `notRunning` });
    const first = (await load()).useLocalProject();
    await nextTick();
    first.fold(true);
    const second = (await load()).useLocalProject();
    await nextTick();
    expect(second.minimized.value).toBe(true);
    setup.value = CREATING;
    await nextTick();
    expect(second.minimized.value).toBe(false);
});

it(`says on the card why a press did nothing`, async () => {
    const { act } = fakeProject(NEW);
    setup.value = setupOf({ state: `failed`, reason: `The platform couldn't make the sandbox.` });
    const flow = (await load()).useLocalProject();
    act.mockRejectedValueOnce(new Error(`The machine agent didn't answer in time.`));
    await flow.pressed(() => act(`retry`));
    expect(flow.actionFailure.value).toBe(`The machine agent didn't answer in time.`);
});

/* THE WAY THROUGH A SIGN-IN, AND INTO THE SANDBOX (2026-10-17): a reader who pressed "Sign in and work on this" was told
   to sign in again by the card all through the browser's sign-in, and was never taken to the folder's sandbox once it
   was in. */

const SIGNED_OUT = setupOf({ state: `signedOut` });

// Whether the reader is looking at this window, as the page reads it.
const lookingHere = (here: boolean): void => {
    Object.defineProperty(document, `visibilityState`, { configurable: true, get: () => (here ? `visible` : `hidden`) });
    Object.defineProperty(document, `hasFocus`, { configurable: true, value: () => here });
};

it(`says to finish signing in while the browser has it, and moves on when the app hears who signed in`, async () => {
    fakeProject({ ...NEW, signedIn: false });
    const flow = (await load()).useLocalProject();
    await flow.ask();
    await flow.create();
    // The app's record of the folder, made by the press: waiting on the sign-in.
    setup.value = SIGNED_OUT;
    expect({ key: flow.card.value?.key, actions: flow.card.value?.actions, signingIn: flow.signingIn.value }).toEqual({
        key: `signingIn`,
        actions: [`signInAgain`],
        signingIn: true,
    });
    setup.value = CREATING;
    await nextTick();
    expect({ key: flow.card.value?.key, signingIn: flow.signingIn.value }).toEqual({ key: `creating`, signingIn: false });
});

it(`asks to sign in again once the sign-in has run out`, async () => {
    fakeProject({ ...NEW, signedIn: false });
    setup.value = SIGNED_OUT;
    const flow = (await load()).useLocalProject();
    await flow.signIn();
    expect(flow.card.value?.key).toBe(`signingIn`);
    jest.advanceTimersByTime(3 * 60_000);
    expect(flow.card.value?.key).toBe(`signedOut`);
});

it(`takes the reader into the folder's sandbox once the folder this window asked for is in`, async () => {
    const { open } = fakeProject(NEW);
    const flow = (await load()).useLocalProject();
    await flow.ask();
    await flow.create();
    setup.value = setupOf({ state: `copying` }, { status: `staging`, made: true });
    await nextTick();
    lookingHere(true);
    setup.value = setupOf({ state: `ready` }, { made: true });
    await nextTick();
    expect(open).toHaveBeenCalledTimes(1);
});

it(`leaves the ready card up, rather than moving a reader who is elsewhere`, async () => {
    const { open } = fakeProject(NEW);
    const flow = (await load()).useLocalProject();
    await flow.ask();
    await flow.create();
    setup.value = setupOf({ state: `copying` }, { status: `staging`, made: true });
    await nextTick();
    lookingHere(false);
    setup.value = setupOf({ state: `ready` }, { made: true });
    await nextTick();
    expect(open).not.toHaveBeenCalled();
    jest.advanceTimersByTime(60_000);
    expect(flow.card.value?.actions).toEqual([`open`]);
});

it(`moves nobody into a sandbox for a folder another window asked for`, async () => {
    const { open } = fakeProject(NEW);
    setup.value = setupOf({ state: `copying` }, { status: `staging`, made: true });
    const flow = (await load()).useLocalProject();
    await nextTick();
    lookingHere(true);
    setup.value = setupOf({ state: `ready` }, { made: true });
    await nextTick();
    expect(open).not.toHaveBeenCalled();
    expect(flow.card.value?.tone).toBe(`ready`);
});

/* THE FOLDER'S SANDBOX ON ITS WAY TO THE SCREEN (folderSandbox.ts `useSandboxOpening`): "Open this folder's sandbox" is
   a link to the app, which took a second or two (longer for a stopped sandbox) before anything moved. The press is seen
   at once, the app's word moves it on or puts it to rest, and an app that never answers cannot hold the button for good. */

const loadOpening = () => freshImport<typeof import("./folderSandbox")>("./folderSandbox", import.meta.url);
const sayOpening = (stage: string): void => {
    window.dispatchEvent(new CustomEvent(`intentic:sandbox-opening`, { detail: { stage } }));
};
// How long each stage holds without the app's word (folderSandbox.ts): opening a listing and a window, starting a boot.
const OPENING_HOLD_MS = 15_000;
const STARTING_HOLD_MS = 120_000;

it(`says opening at once on a press, and puts it to rest when the app says the workspace is up`, async () => {
    const { stage, begin } = (await loadOpening()).useSandboxOpening();
    expect(stage.value).toBeUndefined();
    begin();
    expect(stage.value).toBe(`opening`);
    sayOpening(`shown`);
    expect(stage.value).toBeUndefined();
});

it(`says a stopped sandbox is being started, and holds past the opening's deadline`, async () => {
    const { stage, begin } = (await loadOpening()).useSandboxOpening();
    begin();
    sayOpening(`starting`);
    expect(stage.value).toBe(`starting`);
    jest.advanceTimersByTime(OPENING_HOLD_MS + 1);
    expect(stage.value).toBe(`starting`);
    jest.advanceTimersByTime(STARTING_HOLD_MS);
    expect(stage.value).toBeUndefined();
});

it(`lets the button go at the deadline when the app never answers`, async () => {
    const { stage, begin } = (await loadOpening()).useSandboxOpening();
    begin();
    jest.advanceTimersByTime(OPENING_HOLD_MS - 1);
    expect(stage.value).toBe(`opening`);
    jest.advanceTimersByTime(1);
    expect(stage.value).toBeUndefined();
});

it(`changes nothing for a word nobody pressed for, or one it cannot read`, async () => {
    const { stage, begin } = (await loadOpening()).useSandboxOpening();
    sayOpening(`shown`);
    expect(stage.value).toBeUndefined();
    begin();
    sayOpening(`opening`);
    window.dispatchEvent(new CustomEvent(`intentic:sandbox-opening`, { detail: null }));
    expect(stage.value).toBe(`opening`);
});
