//
/* THE BROWSERS VIEW'S STRIP, AND THE WELCOME THAT MUST NOT BECOME A HABIT. */
import "@intentic/testing/dom";
import { freshImport, mocked } from "@intentic/testing/bun";
import { browsersPath, parseTabKey, previewRedirect, tabKey, type LiveTab } from "./browsersPaths";

const SANDBOX = `sbx-1`;
// The active sandbox's row, whose `role` decides whether the reader may see the view at all.
const active = { value: undefined as { role: string } | undefined };

jest.mock(`../../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ activeSandboxId: { value: SANDBOX }, active }) }));

// Where the reader stands decides whether a tab comes to front in place or the view opens beside.
const currentRoute = { value: { name: `agents` } };
// SAFETY: the openers reach only `push` and `currentRoute.value.name` of a router; nothing else is called here.
const router = { push: jest.fn(), currentRoute } as unknown as import("vue-router").Router;

const { closeAllTabs, sideDocked, sideTabId, useSidePanel } = await import("../../workbench/side/sideTabs");

// The view's state is module state, so a case that asks what a fresh window does needs a fresh evaluation.
const load = () => freshImport<typeof import("./browsersSurface")>("./browsersSurface", import.meta.url);

const landing: LiveTab = { kind: `preview`, id: `app:site/landing` };

beforeEach(() => {
    localStorage.clear();
    mocked(router.push).mockClear();
    sideDocked.value = false;
    currentRoute.value = { name: `agents` };
    active.value = undefined;
    closeAllTabs();
});

describe(`a tab's key`, () => {
    it.each<[LiveTab, string]>([
        [{ kind: `web`, session: undefined }, ``],
        [{ kind: `web`, session: `browser-own` }, `browser-own`],
        [{ kind: `preview`, id: `app:shop/web` }, `preview:app:shop/web`],
        [{ kind: `desktop` }, `desktop`],
        [{ kind: `app`, id: `0x1a00003` }, `app:0x1a00003`],
    ])(`round-trips %o as %s`, (tab, key) => {
        expect(tabKey(tab)).toBe(key);
        expect(parseTabKey(key)).toEqual(tab);
    });

    it(`reads a kind with nothing after it as a web window's name, never as an empty pin`, () => {
        expect(parseTabKey(`preview:`)).toEqual({ kind: `web`, session: `preview:` });
        expect(parseTabKey(`app:`)).toEqual({ kind: `web`, session: `app:` });
    });

    it(`is the route's own tail`, () => {
        expect(browsersPath()).toBe(`/browsers`);
        expect(browsersPath({ kind: `desktop` })).toBe(`/browsers/desktop`);
        expect(browsersPath(landing)).toBe(`/browsers/preview:app:site/landing`);
    });

    it(`sends the old /preview address to the app it named, or asks the view to pick one`, () => {
        expect(previewRedirect(`port:5173`)).toEqual({ path: `/browsers/preview:port:5173`, query: {} });
        expect(previewRedirect(undefined)).toEqual({ path: `/browsers`, query: { preview: null } });
        expect(previewRedirect(``)).toEqual({ path: `/browsers`, query: { preview: null } });
    });
});

describe(`the strip`, () => {
    it(`pins a tab once, however often it is shown, and puts it in front`, async () => {
        const { browsersFront, browsersPinned, showTab } = await load();
        showTab(landing);
        showTab({ kind: `desktop` });
        showTab(landing);

        expect(browsersPinned.value.map(tabKey)).toEqual([`preview:app:site/landing`, `desktop`]);
        expect(browsersFront.value).toEqual(landing);
    });

    it(`hands the front to the neighbour of a pin taken off, and to the web windows after the last`, async () => {
        const { browsersFront, browsersPinned, showTab, unpinTab } = await load();
        showTab(landing);
        showTab({ kind: `desktop` });
        showTab(landing);

        unpinTab(landing);
        expect(browsersFront.value).toEqual({ kind: `desktop` });
        unpinTab({ kind: `desktop` });
        expect(browsersFront.value).toEqual({ kind: `web`, session: undefined });
        expect(browsersPinned.value).toEqual([]);
    });

    it(`comes back after a reload, front and all`, async () => {
        const first = await load();
        first.showTab({ kind: `desktop` });
        first.showTab(landing);

        const second = await load();
        expect(second.browsersPinned.value.map(tabKey)).toEqual([`desktop`, `preview:app:site/landing`]);
        expect(second.browsersFront.value).toEqual(landing);
    });

    it(`starts on the app the old Preview view showed last, so the move loses nobody's app`, async () => {
        localStorage.setItem(`intentic-preview-target:${SANDBOX}`, `port:5173`);
        const { browsersFront, browsersPinned } = await load();

        expect(browsersPinned.value).toEqual([{ kind: `preview`, id: `port:5173` }]);
        expect(browsersFront.value).toEqual({ kind: `preview`, id: `port:5173` });
    });
});

it(`opens the live app on the first visit, on the target it was given`, async () => {
    const { openPreviewOnFirstVisit, browsersOpened, browsersFront } = await load();

    expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);
    expect(browsersOpened.value).toBe(true);
    expect(browsersFront.value).toEqual(landing);
    expect(router.push).toHaveBeenCalledWith(`/browsers/preview:app:site/landing`);
});

it(`never opens it a second time, not even across a reload`, async () => {
    const first = await load();
    expect(first.openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);

    // A reload: fresh module state, the same origin's storage. The visit is not the first one any more.
    const second = await load();
    expect(second.openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(false);
    expect(second.browsersOpened.value).toBe(false);
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

it(`asked for the live app without one named, leaves the pick to the view, which knows the apps`, async () => {
    const { openPreview, browsersWantPreview } = await load();
    openPreview(router);

    expect(browsersWantPreview.value).toBe(true);
    expect(router.push).toHaveBeenCalledWith(`/browsers`);
});

// A server a turn left running, a localhost link: what it serves is shown beside the section the reader is in.
describe(`a running app someone points at, with the side panel in the window`, () => {
    const panel = useSidePanel();

    beforeEach(() => {
        sideDocked.value = true;
    });

    it(`opens beside the section on the app named, kept, and leaves the main area where it was`, async () => {
        const { openPreviewBeside, browsersOpened, browsersFront } = await load();
        openPreviewBeside(router, `port:5173`);

        expect(panel.tabs.value.map((tab) => tab.view)).toEqual([`browsers`]);
        expect(panel.active.value).toBe(sideTabId(`browsers`, {}));
        expect(panel.peek.value).toBeNull();
        expect(browsersOpened.value).toBe(true);
        expect(browsersFront.value).toEqual({ kind: `preview`, id: `port:5173` });
        expect(router.push).not.toHaveBeenCalled();
    });

    it(`comes to front in place while the reader stands on /browsers`, async () => {
        currentRoute.value = { name: `browsers` };
        const { openPreviewBeside, browsersFront } = await load();
        openPreviewBeside(router, `port:5173`);

        expect(router.push).toHaveBeenCalledWith(`/browsers/preview:port:5173`);
        expect(browsersFront.value).toEqual({ kind: `preview`, id: `port:5173` });
        expect(panel.tabs.value).toEqual([]);
    });

    it(`goes to /browsers, as before, for a reader the view is closed to`, async () => {
        active.value = { role: `guest` };
        const { openPreviewBeside } = await load();
        openPreviewBeside(router, `port:5173`);

        expect(router.push).toHaveBeenCalledWith(`/browsers/preview:port:5173`);
        expect(panel.tabs.value).toEqual([]);
    });

    it(`welcomes a first visit beside the Workspace rather than taking its place`, async () => {
        currentRoute.value = { name: `workspace` };
        const { openPreviewOnFirstVisit } = await load();
        expect(openPreviewOnFirstVisit(router, `app:site/landing`)).toBe(true);

        expect(panel.tabs.value.map((tab) => tab.view)).toEqual([`browsers`]);
        expect(router.push).not.toHaveBeenCalled();
    });
});
