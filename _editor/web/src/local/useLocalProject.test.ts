import "@intentic/testing/dom";
import { freshImport, stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { ref } from "vue";
import { LINK_HOST, type LocalHost, type LocalProjectBuild, type LocalProjectHost, type LocalProjectPreview } from "../app/environments/localHost";

// "Work on this with an agent" in a folder's window: its own dialog, the sandbox made under names derived from the
// folder's, and a press that never asks twice while a build is under way. The app is a fake host; the links a page
// without one sends are caught where they leave (desktop.ts sends them a beat apart, so the clock is walked).

const load = () => freshImport<typeof import("./useLocalProject")>("./useLocalProject", import.meta.url);

const NEW: LocalProjectPreview = {
    kind: `new`,
    name: `test-remove-me`,
    path: `C:\\Users\\me\\Documents\\test-remove-me`,
    files: 3,
    bytes: 355,
    more: false,
    large: false,
    cautions: [],
    signedIn: true,
    busy: false,
};

const build = ref<LocalProjectBuild | undefined>(undefined);

const fakeProject = (preview: LocalProjectPreview, created: Promise<`building` | `signIn` | `opened`> = Promise.resolve(`building`)) => {
    const asked = jest.fn(async () => preview);
    const made = jest.fn(async () => created);
    const project: LocalProjectHost = {
        preview: asked,
        create: made,
        build,
        open: jest.fn(async () => undefined),
        retry: jest.fn(async () => undefined),
        stop: jest.fn(async () => undefined),
        dismiss: jest.fn(),
        detailsPath: `/device`,
    };
    const host: LocalHost = {
        ...LINK_HOST,
        native: true,
        roster: async () => ({ account: null, sandboxes: [{ id: `cm1`, name: `test-remove-me`, place: `device`, shared: false }] }),
        project,
    };
    window.__INTENTIC_LOCAL_HOST__ = host;
    return { asked, made };
};

let heard: string[] = [];
beforeEach(() => {
    jest.useFakeTimers();
    heard = [];
    build.value = undefined;
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

// The account already has a sandbox by the folder's name: the new one is numbered past it, as /setup numbers one.
it(`makes the sandbox under names derived from the folder's, and puts the dialog away for the build's card`, async () => {
    const { made } = fakeProject(NEW);
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.ask();
    flow.fold(true);
    await flow.create();
    expect(made).toHaveBeenCalledWith({ name: `test-remove-me-2`, project: `test-remove-me` });
    expect({ open: flow.dialogOpen.value, folded: flow.minimized.value }).toEqual({ open: false, folded: false });
});

it(`keeps the dialog up with the app's own reason when nothing was made`, async () => {
    fakeProject(NEW, Promise.reject(new Error(`The platform could not be reached. Check your connection and try again.`)));
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.ask();
    await flow.create();
    expect({ open: flow.dialogOpen.value, failure: flow.failure.value, creating: flow.creating.value }).toEqual({
        open: true,
        failure: `The platform could not be reached. Check your connection and try again.`,
        creating: false,
    });
});

it(`makes nothing for a folder that cannot have a sandbox`, async () => {
    const { made } = fakeProject({ kind: `refused`, refusal: { kind: `disk` } });
    const flow = (await load()).useLocalProject();
    await flow.ask();
    await flow.create();
    expect(made).not.toHaveBeenCalled();
});

it(`brings back the card of a build under way rather than asking a second time`, async () => {
    const { asked } = fakeProject(NEW);
    build.value = { name: `test-remove-me`, state: `building`, phase: `pulling-image`, phaseProgress: 0.2, step: `Download`, percent: 30, remainingMs: 60_000, error: undefined };
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    flow.fold(true);
    await flow.ask();
    expect({ open: flow.dialogOpen.value, folded: flow.minimized.value, previewed: asked.mock.calls.length }).toEqual({
        open: false,
        folded: false,
        previewed: 0,
    });
});

it(`asks the app by link where there is no app behind the page to make one`, async () => {
    const { useLocalProject } = await load();
    await useLocalProject().ask();
    expect(links()).toEqual([`intentic://local?do=sandbox`]);
});

it(`brings back a stopped build's card too, where its "Try again" keeps the same sandbox`, async () => {
    const { asked } = fakeProject(NEW);
    build.value = { name: `test-remove-me`, state: `failed`, phase: `claiming-code`, phaseProgress: 0, step: undefined, percent: 8, remainingMs: undefined, error: `refused` };
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    flow.fold(true);
    await flow.ask();
    expect({ open: flow.dialogOpen.value, folded: flow.minimized.value, previewed: asked.mock.calls.length }).toEqual({ open: false, folded: false, previewed: 0 });
});

it(`says on the card why "Try again" started nothing`, async () => {
    fakeProject(NEW);
    const host = window.__INTENTIC_LOCAL_HOST__;
    const project = host?.project;
    if (host === undefined || project === undefined) {
        throw new Error(`no host`);
    }
    window.__INTENTIC_LOCAL_HOST__ = {
        ...host,
        project: {
            ...project,
            retry: async () => {
                throw new Error(`The platform could not be reached.`);
            },
        },
    };
    const { useLocalProject } = await load();
    const flow = useLocalProject();
    await flow.retry();
    expect(flow.retryFailure.value).toBe(`The platform could not be reached.`);
});
