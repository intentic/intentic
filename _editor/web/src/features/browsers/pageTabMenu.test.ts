import type { BrowserClosedTab, BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import type { MenuItem } from "primevue/menuitem";
import { type TabMenuActions, tabMenu } from "./pageTabMenu";

const words = {
    reload: `Reload`,
    duplicate: `Duplicate`,
    mute: `Mute tab`,
    unmute: `Unmute tab`,
    copyAddress: `Copy address`,
    close: `Close tab`,
    closeOthers: `Close other tabs`,
    closeRight: `Close tabs to the right`,
    reopen: `Reopen closed tab`,
    recentlyClosed: `Recently closed`,
};

const page = (id: string, extra: Partial<BrowserPage> = {}): BrowserPage => ({ id, url: `https://${id}.test/`, active: false, ...extra });

const actions = (): TabMenuActions & { readonly calls: string[] } => {
    const calls: string[] = [];
    return {
        calls,
        reload: () => calls.push(`reload`),
        duplicate: () => calls.push(`duplicate`),
        mute: (muted) => calls.push(muted ? `mute` : `unmute`),
        copyAddress: () => calls.push(`copy`),
        close: () => calls.push(`close`),
        closeOthers: () => calls.push(`closeOthers`),
        closeRight: () => calls.push(`closeRight`),
        reopen: (closedId) => calls.push(`reopen:${closedId ?? `last`}`),
    };
};

// The menu as a line of its rows, a separator as `—` and a submenu's rows in brackets after its label.
const rows = (items: readonly MenuItem[]): string =>
    items.map((item) => (item.separator === true ? `—` : item.items === undefined ? String(item.label) : `${String(item.label)} [${rows(item.items)}]`)).join(` | `);

const run = (items: readonly MenuItem[], label: string): void => {
    const row = items.flatMap((item) => [item, ...(item.items ?? [])]).find((item) => item.label === label);
    row?.command?.({ originalEvent: new Event(`click`), item: row });
};

describe(`a web page tab's own menu`, () => {
    test(`offers what a browser's does, in its order, for a tab among others`, () => {
        const pages = [page(`a`), page(`b`), page(`c`)];
        expect(rows(tabMenu({ page: pages[1] ?? page(`b`), pages, closed: [], words, act: actions() }))).toBe(
            `Reload | Duplicate | Copy address | — | Close tab | Close other tabs | Close tabs to the right`,
        );
    });

    test(`leaves out what would do nothing: no others to close, none to the right, nothing to copy or duplicate`, () => {
        const lone = page(`a`, { url: `about:blank` });
        expect(rows(tabMenu({ page: lone, pages: [lone], closed: [], words, act: actions() }))).toBe(`Reload | — | Close tab`);
        const pages = [page(`a`), page(`b`)];
        expect(rows(tabMenu({ page: pages[1] ?? page(`b`), pages, closed: [], words, act: actions() }))).toBe(
            `Reload | Duplicate | Copy address | — | Close tab | Close other tabs`,
        );
    });

    test(`mutes a tab the window can say the sound of, and unmutes a muted one`, () => {
        const act = actions();
        const playing = page(`a`, { audible: true, muted: false });
        const playingMenu = tabMenu({ page: playing, pages: [playing], closed: [], words, act });
        expect(rows(playingMenu)).toContain(`Duplicate | Mute tab | Copy address`);
        run(playingMenu, `Mute tab`);
        const muted = page(`a`, { audible: true, muted: true });
        run(tabMenu({ page: muted, pages: [muted], closed: [], words, act }), `Unmute tab`);
        expect(act.calls).toEqual([`mute`, `unmute`]);
        // A window that cannot say (an agent's) offers no mute at all.
        expect(rows(tabMenu({ page: page(`a`), pages: [page(`a`)], closed: [], words, act }))).not.toContain(`Mute`);
        expect(rows(tabMenu({ page: playing, pages: [playing], closed: [], words, act: { ...act, mute: undefined } }))).not.toContain(`Mute`);
    });

    test(`brings back the last closed tab, or one of the recently closed by its name`, () => {
        const act = actions();
        const closed: BrowserClosedTab[] = [
            { id: `c2`, url: `https://news.test/story`, title: `A story`, closedAt: 2 },
            { id: `c1`, url: `https://plain.test/path`, closedAt: 1 },
        ];
        const menu = tabMenu({ page: page(`a`), pages: [page(`a`)], closed, words, act });
        expect(rows(menu)).toBe(`Reload | Duplicate | Copy address | — | Close tab | — | Reopen closed tab | Recently closed [A story | plain.test]`);
        run(menu, `Reopen closed tab`);
        run(menu, `plain.test`);
        expect(act.calls).toEqual([`reopen:last`, `reopen:c1`]);
    });

    test(`every row does its own thing`, () => {
        const act = actions();
        const pages = [page(`a`), page(`b`), page(`c`)];
        const menu = tabMenu({ page: pages[0] ?? page(`a`), pages, closed: [], words, act });
        for (const label of [`Reload`, `Duplicate`, `Copy address`, `Close tab`, `Close other tabs`, `Close tabs to the right`]) {
            run(menu, label);
        }
        expect(act.calls).toEqual([`reload`, `duplicate`, `copy`, `close`, `closeOthers`, `closeRight`]);
    });
});
