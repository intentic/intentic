import type { BrowserPage, BrowserPageAction, BrowserSession, OpenBrowserResult } from "@intentic/sandbox-contract/schemas/terminal";
import { computed, nextTick, ref } from "vue";
import type { StripTab } from "./stripTab";
import { type TabRpc, useHeldOrder, useTabVerbs } from "./tabVerbs";

const page = (id: string, extra: Partial<BrowserPage> = {}): BrowserPage => ({ id, url: `https://${id}.test/`, active: false, ...extra });
const window = (name: string, pages: readonly BrowserPage[], extra: Partial<BrowserSession> = {}): BrowserSession => ({
    name,
    label: name,
    server: `_own`,
    running: true,
    activityAt: 0,
    own: true,
    pages: [...pages],
    ...extra,
});

// The daemon's verbs as calls written down, each answering what the test hands it.
const fakeRpc = (answers: { readonly reopen?: OpenBrowserResult; readonly act?: OpenBrowserResult } = {}) => {
    const calls: string[] = [];
    const rpc: TabRpc = {
        closeWindow: async (name) => void calls.push(`closeWindow ${name}`),
        closePage: async (name, pageId) => void calls.push(`closePage ${name} ${pageId}`),
        reopen: async (name, closedId) => {
            calls.push(`reopen ${name} ${closedId ?? `last`}`);
            return answers.reopen ?? { name };
        },
        move: async (name, pageId, index) => {
            calls.push(`move ${name} ${pageId} ${index}`);
            return { name };
        },
        act: async (name, pageId, action: BrowserPageAction) => {
            calls.push(`${action} ${name} ${pageId}`);
            return answers.act ?? { name, pageId };
        },
    };
    return { rpc, calls };
};

const stage = (sessions: readonly BrowserSession[], options: { readonly front?: string; readonly rpc?: ReturnType<typeof fakeRpc>; readonly usable?: boolean } = {}) => {
    const { rpc, calls } = options.rpc ?? fakeRpc();
    const order = useHeldOrder();
    const current = ref<BrowserSession | undefined>(sessions[0]);
    const pages = computed(() => (current.value === undefined ? [] : order.ordered(current.value)));
    const picked = ref<string | undefined>(options.front);
    const activePage = computed(() => pages.value.find((listed) => listed.id === picked.value));
    const stripTabs = computed<StripTab[]>(() =>
        sessions.flatMap((session) =>
            order.ordered(session).map((listed) => ({
                id: `${session.name}:${listed.id}`,
                label: listed.id,
                icon: `globe` as const,
                closable: true,
                movable: true,
                pinned: false,
                group: { id: session.name, label: session.name, mark: { kind: `icon` as const, icon: `user` as const }, current: false },
            })),
        ),
    );
    const entryOf = (stripId: string) => {
        const [name, pageId] = stripId.split(`:`);
        const session = sessions.find((listed) => listed.name === name);
        const found = session === undefined ? undefined : order.ordered(session).find((listed) => listed.id === pageId);
        return session === undefined || found === undefined ? undefined : { session, page: found };
    };
    const awaited: string[] = [];
    const inView: string[] = [];
    const verbs = useTabVerbs({
        current,
        pages,
        activePage,
        interactive: ref(true),
        usable: () => options.usable ?? true,
        pickPage: (chosen) => (picked.value = chosen.id),
        closeInView: (pageId) => inView.push(pageId),
        awaitTab: (pending) => awaited.push(`${pending.name}:${pending.pageId}`),
        entryOf,
        stripTabs,
        order,
        rpc,
    });
    const tabOf = (stripId: string): StripTab => stripTabs.value.find((listed) => listed.id === stripId) ?? stripTabs.value[0]!;
    return { verbs, calls, picked, awaited, inView, tabOf, stripTabs, order };
};

// A row of a tab's menu, run as a press on it.
const press = (verbs: ReturnType<typeof stage>[`verbs`], tab: StripTab, label: string): void => {
    const rows = verbs.menuOf(tab).flatMap((row) => [row, ...(row.items ?? [])]);
    const row = rows.find((candidate) => candidate.label === label);
    row?.command?.({ originalEvent: new Event(`click`), item: row });
};

const flush = async (): Promise<void> => {
    await Promise.resolve();
    await nextTick();
};

describe(`closing around a tab from its menu`, () => {
    test(`close other tabs puts the kept tab in front first when the one in front is going`, () => {
        const own = window(`browser-own`, [page(`a`), page(`b`), page(`c`)]);
        const { verbs, calls, picked, tabOf } = stage([own], { front: `c` });
        press(verbs, tabOf(`browser-own:b`), `Close other tabs`);
        expect(picked.value).toBe(`b`);
        expect(calls).toEqual([`closePage browser-own a`, `closePage browser-own c`]);
    });

    test(`close tabs to the right leaves the ones before it and the one in front alone`, () => {
        const own = window(`browser-own`, [page(`a`), page(`b`), page(`c`), page(`d`)]);
        const { verbs, calls, picked, tabOf } = stage([own], { front: `a` });
        press(verbs, tabOf(`browser-own:b`), `Close tabs to the right`);
        expect(picked.value).toBe(`a`);
        expect(calls).toEqual([`closePage browser-own c`, `closePage browser-own d`]);
    });

    test(`closing the last tab of the person's own window closes the window, as a browser's last tab does`, () => {
        const own = window(`browser-own`, [page(`a`)]);
        const { verbs, calls, inView, tabOf } = stage([own], { front: `a` });
        press(verbs, tabOf(`browser-own:a`), `Close tab`);
        expect(calls).toEqual([`closeWindow browser-own`]);
        expect(inView).toEqual([]);
    });

    test(`a window the person's hands do not reach (an agent at work in it) has no menu`, () => {
        const agent = window(`browser-agent`, [page(`a`), page(`b`)], { own: false });
        const { verbs, tabOf } = stage([agent], { usable: false });
        expect(verbs.menuOf(tabOf(`browser-agent:a`))).toEqual([]);
    });
});

describe(`bringing a closed tab back`, () => {
    test(`Ctrl+Shift+T reopens the window in front's last closed tab and puts it in front once listed`, async () => {
        const own = window(`browser-own`, [page(`a`)], { closed: [{ id: `c1`, url: `https://gone.test/`, closedAt: 1 }] });
        const staged = stage([own], { rpc: fakeRpc({ reopen: { name: `browser-own`, pageId: `p9` } }) });
        staged.verbs.reopenClosedTab();
        await flush();
        expect(staged.calls).toEqual([`reopen browser-own last`]);
        expect(staged.awaited).toEqual([`browser-own:p9`]);
    });

    test(`the menu's recently closed list reopens the one named`, async () => {
        const own = window(`browser-own`, [page(`a`)], {
            closed: [
                { id: `c2`, url: `https://two.test/`, title: `Two`, closedAt: 2 },
                { id: `c1`, url: `https://one.test/`, title: `One`, closedAt: 1 },
            ],
        });
        const { verbs, calls, tabOf } = stage([own]);
        press(verbs, tabOf(`browser-own:a`), `One`);
        await flush();
        expect(calls).toEqual([`reopen browser-own c1`]);
    });
});

describe(`a tab's other verbs`, () => {
    test(`a copy goes in front once listed; a reload and a mute act on the tab named`, async () => {
        const own = window(`browser-own`, [page(`a`, { audible: true, muted: false }), page(`b`, { muted: true })]);
        const staged = stage([own], { rpc: fakeRpc({ act: { name: `browser-own`, pageId: `p7` } }) });
        press(staged.verbs, staged.tabOf(`browser-own:a`), `Duplicate`);
        press(staged.verbs, staged.tabOf(`browser-own:a`), `Reload`);
        staged.verbs.muteTab(staged.tabOf(`browser-own:a`));
        staged.verbs.muteTab(staged.tabOf(`browser-own:b`));
        await flush();
        expect(staged.calls).toEqual([`duplicate browser-own a`, `reload browser-own a`, `mute browser-own a`, `unmute browser-own b`]);
        expect(staged.awaited).toEqual([`browser-own:p7`]);
    });
});

describe(`dragging a tab to a new place`, () => {
    test(`holds the new order at once and tells the window the place among its own tabs`, () => {
        const own = window(`browser-own`, [page(`a`), page(`b`), page(`c`)]);
        const { verbs, calls, tabOf, stripTabs } = stage([own]);
        verbs.moveTab(tabOf(`browser-own:a`), 2);
        expect(stripTabs.value.map((tab) => tab.id)).toEqual([`browser-own:b`, `browser-own:c`, `browser-own:a`]);
        expect(calls).toEqual([`move browser-own a 2`]);
    });

    test(`another window's run, or the place it already has, moves nothing`, () => {
        const own = window(`browser-own`, [page(`a`), page(`b`)]);
        const other = window(`browser-agent`, [page(`x`)], { own: false });
        const { verbs, calls, tabOf } = stage([own, other]);
        verbs.moveTab(tabOf(`browser-own:b`), 1);
        verbs.moveTab(tabOf(`browser-own:a`), 5);
        expect(calls).toEqual([]);
    });

    test(`a held order gives way to the window's own once a tab opens or closes`, () => {
        const order = useHeldOrder();
        const before = window(`browser-own`, [page(`a`), page(`b`)]);
        order.hold(`browser-own`, [`b`, `a`]);
        expect(order.ordered(before).map((listed) => listed.id)).toEqual([`b`, `a`]);
        const grown = window(`browser-own`, [page(`a`), page(`b`), page(`c`)]);
        expect(order.ordered(grown).map((listed) => listed.id)).toEqual([`a`, `b`, `c`]);
        expect(order.ordered(window(`browser-other`, [page(`a`), page(`b`)])).map((listed) => listed.id)).toEqual([`a`, `b`]);
    });
});
