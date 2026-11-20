import type { BrowserPage, BrowserPageAction, BrowserSession, OpenBrowserResult } from "@intentic/sandbox-contract/schemas/terminal";
import { writeClipboard } from "@intentic/ui/clipboard";
import { t } from "@intentic/ui/i18n";
import type { MenuItem } from "primevue/menuitem";
import { shallowRef, type Ref } from "vue";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { closeBrowser, closeBrowserPage } from "./browsersQuery";
import { runOf, type StripTab } from "./stripTab";
import { tabMenu } from "./pageTabMenu";

// WHAT CAN BE DONE TO A WEB PAGE'S TAB, whichever window it is in: close it (the last of the person's own window takes
// the window with it), close the others or the ones after it, bring back a closed one, reload, copy, mute or move it.
// The window in front closes over its picture's socket; everything else goes over the roster's own calls, which reach a
// window with no socket open. The order a drag leaves is held here until the window says it too, so a dropped tab does
// not snap back for the beat the daemon takes to answer.

// The daemon's tab verbs, a seam so a suite can hand its own.
export interface TabRpc {
    readonly closeWindow: (name: string) => Promise<void>;
    readonly closePage: (name: string, pageId: string) => Promise<void>;
    readonly reopen: (name: string, closedId: string | undefined) => Promise<OpenBrowserResult>;
    readonly move: (name: string, pageId: string, index: number) => Promise<OpenBrowserResult>;
    readonly act: (name: string, pageId: string, action: BrowserPageAction) => Promise<OpenBrowserResult>;
}

// A refused verb answers the window alone, as one that found nothing to do: the strip relists either way.
const logged =
    <A extends unknown[]>(what: string, run: (...args: A) => Promise<OpenBrowserResult>) =>
    async (...args: A): Promise<OpenBrowserResult> => {
        try {
            return await run(...args);
        } catch (error) {
            console.error(`browser tab: ${what} failed`, error);
            return { name: String(args[0]) };
        }
    };

const liveTabRpc: TabRpc = {
    closeWindow: closeBrowser,
    closePage: closeBrowserPage,
    reopen: logged(`reopen`, (name: string, closedId: string | undefined) =>
        sandboxRpc.system.reopenBrowserPage(closedId === undefined ? { name } : { name, closedId }),
    ),
    move: logged(`move`, async (name: string, pageId: string, index: number) => {
        await sandboxRpc.system.moveBrowserPage({ name, pageId, index });
        return { name };
    }),
    act: logged(`action`, (name: string, pageId: string, action: BrowserPageAction) => sandboxRpc.system.browserPageAction({ name, pageId, action })),
};

// How long a dragged order stands without the window confirming it, before the window's own order is shown again.
const HOLD_MS = 3000;

// The order a drag just left, by window, shown until the window lists its tabs that way itself.
export const useHeldOrder = () => {
    const held = shallowRef<{ readonly name: string; readonly ids: readonly string[] } | undefined>();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const hold = (name: string, ids: readonly string[]): void => {
        held.value = { name, ids };
        clearTimeout(timer);
        timer = setTimeout(() => (held.value = undefined), HOLD_MS);
    };
    // The window's pages in the held order while it holds and the same tabs are open; as listed otherwise.
    const ordered = (session: BrowserSession): readonly BrowserPage[] => {
        const standing = held.value;
        if (standing?.name !== session.name || standing.ids.length !== session.pages.length) {
            return session.pages;
        }
        const byId = new Map(session.pages.map((page) => [page.id, page]));
        const pages = standing.ids.flatMap((id) => {
            const page = byId.get(id);
            return page === undefined ? [] : [page];
        });
        return pages.length === session.pages.length ? pages : session.pages;
    };
    return { hold, ordered };
};
export type HeldOrder = ReturnType<typeof useHeldOrder>;

export interface TabVerbsDeps {
    // The window whose picture is open, its pages in strip order, and the one in front.
    readonly current: Ref<BrowserSession | undefined>;
    readonly pages: Ref<readonly BrowserPage[]>;
    readonly activePage: Ref<BrowserPage | undefined>;
    // Whether the person's hands reach the window in front now, and whether they reach a given window.
    readonly interactive: Ref<boolean>;
    readonly usable: (session: BrowserSession) => boolean;
    readonly pickPage: (page: BrowserPage) => void;
    // A close over the window in front's own socket.
    readonly closeInView: (pageId: string) => void;
    // A tab a verb opened in the window in front, put in front once the window lists it.
    readonly awaitTab: (pending: { readonly name: string; readonly pageId: string; readonly focus: `page` }) => void;
    // The page a strip tab stands for, and the strip as drawn.
    readonly entryOf: (stripId: string) => { readonly session: BrowserSession; readonly page: BrowserPage } | undefined;
    readonly stripTabs: Ref<readonly StripTab[]>;
    readonly order: HeldOrder;
    readonly rpc?: TabRpc;
}

// The closes: one tab, the others, the ones after one.
const useTabCloses = (deps: TabVerbsDeps, rpc: TabRpc) => {
    const { current, pages, activePage, interactive, usable, pickPage, order } = deps;

    // Closing the tab in front puts its neighbour in front (the one after it, else the one before), as a browser does. The
    // last tab of the person's own window takes the window with it, which is what closing a browser's last tab does.
    const closeTab = (page: BrowserPage): void => {
        const here = current.value;
        if (here === undefined || !interactive.value) {
            return;
        }
        if (here.own === true && pages.value.length === 1) {
            void rpc.closeWindow(here.name);
            return;
        }
        if (page.id === activePage.value?.id) {
            const at = pages.value.findIndex((listed) => listed.id === page.id);
            const neighbour = pages.value[at + 1] ?? pages.value[at - 1];
            if (neighbour !== undefined) {
                pickPage(neighbour);
            }
        }
        deps.closeInView(page.id);
    };

    // A tab closed in a window not in front: over the roster's own call, since only the window in front has a socket open.
    // The last tab of the person's own window takes the window with it, as it does in front.
    const closeElsewhere = (session: BrowserSession, page: BrowserPage): void => {
        if (!usable(session)) {
            return;
        }
        if (session.own === true && session.pages.length === 1) {
            void rpc.closeWindow(session.name);
            return;
        }
        void rpc.closePage(session.name, page.id);
    };

    // Every tab of a window but `keep`, or only those after it: `keep` goes in front first when the tab in front is one
    // of those closing, so the picture never lands on a tab about to go.
    const closeAround = (session: BrowserSession, keep: BrowserPage, onlyAfter: boolean): void => {
        const listed = order.ordered(session);
        const at = listed.findIndex((page) => page.id === keep.id);
        const closing = listed.filter((page, index) => page.id !== keep.id && (!onlyAfter || index > at));
        if (!usable(session) || at < 0 || closing.length === 0) {
            return;
        }
        if (session.name === current.value?.name && closing.some((page) => page.id === activePage.value?.id)) {
            pickPage(keep);
        }
        for (const page of closing) {
            void rpc.closePage(session.name, page.id);
        }
    };

    const close = (session: BrowserSession, page: BrowserPage): void => (session.name === current.value?.name ? closeTab(page) : closeElsewhere(session, page));
    return { closeTab, closeElsewhere, closeAround, close };
};

// The words a tab's menu says.
const menuWords = () => ({
    reload: t(`browsers.browsers.reloadTab`),
    duplicate: t(`browsers.browsers.duplicateTab`),
    mute: t(`browsers.browsers.muteTab`),
    unmute: t(`browsers.browsers.unmuteTab`),
    copyAddress: t(`browsers.browsers.copyTabAddress`),
    close: t(`browsers.browsers.closeTab`),
    closeOthers: t(`browsers.browsers.closeOtherTabs`),
    closeRight: t(`browsers.browsers.closeTabsRight`),
    reopen: t(`browsers.browsers.reopenClosedTab`),
    recentlyClosed: t(`browsers.browsers.recentlyClosed`),
});

export const useTabVerbs = (deps: TabVerbsDeps) => {
    const { current, usable, order } = deps;
    const rpc = deps.rpc ?? liveTabRpc;
    const closes = useTabCloses(deps, rpc);

    // A tab a verb opened goes in front: at once in the window in front, where the strip follows the daemon's word once
    // the tab is listed; another window's daemon already put it in front there.
    const follow = (session: BrowserSession, opened: OpenBrowserResult): void => {
        if (opened.pageId !== undefined && session.name === current.value?.name) {
            deps.awaitTab({ name: session.name, pageId: opened.pageId, focus: `page` });
        }
    };

    const reopen = async (session: BrowserSession, closedId?: string): Promise<void> => {
        if (usable(session)) {
            follow(session, await rpc.reopen(session.name, closedId));
        }
    };

    // Ctrl+Shift+T: the last tab closed in the window in front comes back.
    const reopenClosedTab = (): void => {
        if (current.value !== undefined) {
            void reopen(current.value);
        }
    };

    const act = async (session: BrowserSession, page: BrowserPage, action: BrowserPageAction): Promise<void> => {
        if (usable(session)) {
            const done = await rpc.act(session.name, page.id, action);
            if (action === `duplicate`) {
                follow(session, done);
            }
        }
    };

    // A tab's speaker pressed on the strip.
    const muteTab = (tab: StripTab): void => {
        const entry = deps.entryOf(tab.id);
        if (entry !== undefined) {
            void act(entry.session, entry.page, entry.page.muted === true ? `unmute` : `mute`);
        }
    };

    // A tab let go at `to` among its run on the strip: held there at once, and told to the window.
    const moveTab = (tab: StripTab, to: number): void => {
        const entry = deps.entryOf(tab.id);
        const target = runOf(deps.stripTabs.value, tab.id)[to];
        const onto = target === undefined ? undefined : deps.entryOf(target.id);
        if (entry === undefined || onto === undefined || onto.session.name !== entry.session.name || !usable(entry.session)) {
            return;
        }
        const ids = order.ordered(entry.session).map((page) => page.id);
        const from = ids.indexOf(entry.page.id);
        const index = ids.indexOf(onto.page.id);
        if (from < 0 || index < 0 || from === index) {
            return;
        }
        ids.splice(from, 1);
        ids.splice(index, 0, entry.page.id);
        order.hold(entry.session.name, ids);
        void rpc.move(entry.session.name, entry.page.id, index);
    };

    // A tab's own menu (pageTabMenu.ts), for a web page of a window the person's hands reach.
    const menuOf = (tab: StripTab): MenuItem[] => {
        const entry = deps.entryOf(tab.id);
        if (entry === undefined || !usable(entry.session)) {
            return [];
        }
        const { session, page } = entry;
        return tabMenu({
            page,
            pages: order.ordered(session),
            closed: session.closed ?? [],
            words: menuWords(),
            act: {
                reload: () => void act(session, page, `reload`),
                duplicate: () => void act(session, page, `duplicate`),
                mute: (muted) => void act(session, page, muted ? `mute` : `unmute`),
                copyAddress: () => void writeClipboard(page.url),
                close: () => closes.close(session, page),
                closeOthers: () => closes.closeAround(session, page, false),
                closeRight: () => closes.closeAround(session, page, true),
                reopen: (closedId) => void reopen(session, closedId),
            },
        });
    };

    return { closeTab: closes.closeTab, closeElsewhere: closes.closeElsewhere, reopenClosedTab, muteTab, moveTab, menuOf };
};
