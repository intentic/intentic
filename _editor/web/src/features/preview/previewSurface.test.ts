//
/* THE WELCOME THAT MUST NOT BECOME A HABIT. */
import "@intentic/testing/dom";
import { freshImport, mocked } from "@intentic/testing/bun";

const SANDBOX = `sbx-1`;
// The active sandbox's row, whose `role` decides whether the reader may see the preview at all.
const active = { value: undefined as { role: string } | undefined };

jest.mock(`../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: { value: SANDBOX }, active }) }));

// Where the reader stands decides whether the preview is selected in place or opened beside.
const currentRoute = { value: { name: `agents` } };
// SAFETY: the openers reach only `push` and `currentRoute.value.name` of a router; nothing else is called here.
const router = { push: jest.fn(), currentRoute } as unknown as import("vue-router").Router;

const { closeAllTabs, sideDocked, sideTabId, useSidePanel } = await import("../../workbench/side/sideTabs");

// The panel's `opened` flag is module state, so a case that asks what a fresh window does needs a fresh evaluation.
const load = () => freshImport<typeof import("./previewSurface")>("./previewSurface", import.meta.url);

beforeEach(() => {
    localStorage.clear();
    mocked(router.push).mockClear();
    sideDocked.value = false;
    currentRoute.value = { name: `agents` };
    active.value = undefined;
    closeAllTabs();
});

it(`opens the preview on the first visit, on the target it was given`, async () => {
    const { openPreviewOnFirstVisit, previewOpened, previewSelectedId } = await load();

    expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);
    expect(previewOpened.value).toBe(true);
    expect(previewSelectedId.value).toBe(`app:site/landing`);
    expect(router.push).toHaveBeenCalledWith(`/preview`);
});

it(`never opens it a second time, not even across a reload`, async () => {
    const first = await load();
    expect(first.openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);

    // A reload: fresh module state, the same origin's storage. The visit is not the first one any more.
    const second = await load();
    expect(second.openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(false);
    expect(second.previewOpened.value).toBe(false);
    expect(router.push).toHaveBeenCalledTimes(1);
});

it(`is per sandbox: a box the reader has never opened gets its own welcome`, async () => {
    const { openPreviewOnFirstVisit } = await load();
    expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);
    // The other box's flag, in its own key: this one has still never been visited.
    localStorage.removeItem(`intentic-preview-autoshown:${SANDBOX}`);
    localStorage.setItem(`intentic-preview-autoshown:sbx-2`, `1`);
    expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);
});

// A server a turn left running, a localhost link: what it serves is shown beside the section the reader is in.
describe(`a running app someone points at, with the side panel in the window`, () => {
    const panel = useSidePanel();

    beforeEach(() => {
        sideDocked.value = true;
    });

    it(`opens beside the section on the target named, kept, and leaves the main area where it was`, async () => {
        const { openPreviewBeside, previewOpened, previewSelectedId } = await load();
        openPreviewBeside(router, `port:5173`);

        expect(panel.tabs.value.map((tab) => tab.view)).toEqual([`preview`]);
        expect(panel.active.value).toBe(sideTabId(`preview`, {}));
        expect(panel.peek.value).toBeNull();
        expect(previewOpened.value).toBe(true);
        expect(previewSelectedId.value).toBe(`port:5173`);
        expect(router.push).not.toHaveBeenCalled();
    });

    it(`is selected in place while the reader stands on /preview`, async () => {
        currentRoute.value = { name: `preview` };
        const { openPreviewBeside, previewSelectedId } = await load();
        openPreviewBeside(router, `port:5173`);

        expect(router.push).toHaveBeenCalledWith(`/preview`);
        expect(previewSelectedId.value).toBe(`port:5173`);
        expect(panel.tabs.value).toEqual([]);
    });

    it(`goes to /preview, as before, for a reader the preview is closed to`, async () => {
        active.value = { role: `guest` };
        const { openPreviewBeside } = await load();
        openPreviewBeside(router, `port:5173`);

        expect(router.push).toHaveBeenCalledWith(`/preview`);
        expect(panel.tabs.value).toEqual([]);
    });

    it(`welcomes a first visit beside the Workspace rather than taking its place`, async () => {
        currentRoute.value = { name: `workspace` };
        const { openPreviewOnFirstVisit } = await load();
        expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);

        expect(panel.tabs.value.map((tab) => tab.view)).toEqual([`preview`]);
        expect(router.push).not.toHaveBeenCalled();
    });
});
