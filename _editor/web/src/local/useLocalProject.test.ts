import "@intentic/testing/dom";
import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { nextTick, ref } from "vue";
import {
    LINK_HOST,
    type LocalFolderSandbox,
    type LocalHost,
    type LocalMachineSandbox,
    type LocalProjectHost,
    type LocalProjectPreview,
} from "../app/environments/localHost";

// "Work on this with an agent" in a folder's window: its own dialog, the folder put in line for this computer's sandbox
// under a name derived from the folder's, a press that never waits on the sandbox, and a card that comes back rather
// than a second question while the folder is on its way in. The app is a fake host; the links a page without one sends
// are caught where they leave (desktop.ts sends them a beat apart, so the clock is walked).

const load = () => freshImport<typeof import("./useLocalProject")>("./useLocalProject", import.meta.url);

const CREATING: LocalMachineSandbox = { state: `creating`, phase: `pulling-image`, step: `Download`, percent: 30, name: `ada-laptop sandbox`, waiting: 0, hasLog: false };

const NEW: LocalProjectPreview = {
    kind: `new`,
    name: `My App`,
    path: `C:\\Users\\me\\Documents\\My App`,
    files: 3,
    bytes: 355,
    more: false,
    large: false,
    cautions: [],
    machine: { state: `ready` },
};

const machine = ref<LocalMachineSandbox | undefined>(undefined);
const folder = ref<LocalFolderSandbox | undefined>(undefined);

const fakeProject = (preview: LocalProjectPreview, attached: Promise<`queued` | `opened`> = Promise.resolve(`queued`)) => {
    const asked = jest.fn(async () => preview);
    const attach = jest.fn(async (_names: { readonly project: string }) => attached);
    const act = jest.fn(async () => undefined);
    const open = jest.fn(async () => undefined);
    const project: LocalProjectHost = { preview: asked, attach, machine, folder, open, act, detailsPath: `/device` };
    const host: LocalHost = { ...LINK_HOST, native: true, project };
    window.__INTENTIC_LOCAL_HOST__ = host;
    return { asked, attach, act, open };
};

let heard: string[] = [];
beforeEach(() => {
    jest.useFakeTimers();
    heard = [];
    machine.value = undefined;
    folder.value = undefined;
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

// The folder's name in /work is the folder's own, made safe (`projectDirNameFor`); the app makes it unique.
it(`puts the folder in line under the name derived from its own, and the dialog goes at once`, async () => {
    const { attach, act } = fakeProject(NEW);
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.ask();
    await flow.attach();
    expect(attach).toHaveBeenCalledWith({ project: `My-App` });
    expect(act).not.toHaveBeenCalled();
    expect({ open: flow.dialogOpen.value, folded: flow.minimized.value }).toEqual({ open: false, folded: false });
});

it(`asks for the sign-in at the same press when nobody is signed in, the folder already in line`, async () => {
    const { attach, act } = fakeProject({ ...NEW, machine: { state: `signedOut` } });
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.ask();
    await flow.attach();
    expect(attach).toHaveBeenCalledTimes(1);
    expect(act).toHaveBeenCalledWith(`signIn`);
    expect(flow.dialogOpen.value).toBe(false);
});

it(`keeps the dialog up with the app's own reason when the folder could not go in line`, async () => {
    fakeProject(NEW, Promise.reject(new Error(`This folder can't be used to name a folder in a sandbox.`)));
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.ask();
    await flow.attach();
    expect({ open: flow.dialogOpen.value, failure: flow.failure.value, attaching: flow.attaching.value }).toEqual({
        open: true,
        failure: `This folder can't be used to name a folder in a sandbox.`,
        attaching: false,
    });
});

it(`puts nothing in line for a folder that cannot have a sandbox`, async () => {
    const { attach } = fakeProject({ kind: `refused`, refusal: { kind: `disk` } });
    const flow = (await load()).useLocalProject();
    await flow.ask();
    await flow.attach();
    expect(attach).not.toHaveBeenCalled();
});

it(`brings back the card of a folder on its way in rather than asking a second time`, async () => {
    const { asked } = fakeProject(NEW);
    machine.value = CREATING;
    folder.value = { name: `My-App`, state: `queued`, reason: undefined, status: undefined };
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    flow.fold(true);
    await flow.ask();
    expect({ open: flow.dialogOpen.value, folded: flow.minimized.value, previewed: asked.mock.calls.length }).toEqual({ open: false, folded: false, previewed: 0 });
});

it(`asks the app by link where there is no app behind the page to answer`, async () => {
    const { useLocalProject } = await load();
    await useLocalProject().ask();
    expect(links()).toEqual([`intentic://local?do=sandbox`]);
});

it(`carries the card while this computer's sandbox is not ready, and says for a moment when it is`, async () => {
    fakeProject(NEW);
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    expect(flow.card.value).toBeUndefined();
    machine.value = CREATING;
    await nextTick();
    expect(flow.card.value?.tone).toBe(`working`);
    machine.value = { state: `ready`, name: `ada-laptop sandbox`, waiting: 0, hasLog: false };
    await nextTick();
    expect(flow.card.value?.tone).toBe(`ready`);
    jest.advanceTimersByTime(15_000);
    expect(flow.card.value).toBeUndefined();
});

// A fold is remembered for what the card showed, in every window: the same news stays folded, new news unfolds.
it(`remembers a fold for what it showed, and unfolds for something new`, async () => {
    fakeProject(NEW);
    machine.value = { state: `needsDocker`, reason: `notRunning`, name: undefined, waiting: 0, hasLog: false };
    const first = (await load()).useLocalProject();
    await nextTick();
    first.fold(true);
    const second = (await load()).useLocalProject();
    await nextTick();
    expect(second.minimized.value).toBe(true);
    machine.value = CREATING;
    await nextTick();
    expect(second.minimized.value).toBe(false);
});

it(`puts a turned-down folder in line again under the name it had, and says on the card why that did nothing`, async () => {
    const { attach } = fakeProject(NEW);
    machine.value = { state: `ready`, name: undefined, waiting: 0, hasLog: false };
    folder.value = { name: `My-App`, state: `failed`, reason: `That folder is already attached.`, status: undefined };
    const flow = (await load()).useLocalProject();
    await flow.retryFolder();
    expect(attach).toHaveBeenCalledWith({ project: `My-App` });
    attach.mockRejectedValueOnce(new Error(`The machine agent didn't answer in time.`));
    await flow.retryFolder();
    expect(flow.actionFailure.value).toBe(`The machine agent didn't answer in time.`);
});
