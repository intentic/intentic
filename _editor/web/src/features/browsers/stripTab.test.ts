import type { BrowserPage } from "@intentic/sandbox-contract/schemas/terminal";
import { initialOf, pageTabLook, stripItems, type StripGroup, type StripTab } from "./stripTab";

const group = (id: string): StripGroup => ({ id, label: id, mark: { kind: `icon`, icon: `user` }, current: false });
const tab = (id: string, extra: Partial<StripTab> = {}): StripTab => ({ id, label: id, icon: `globe`, closable: true, pinned: false, ...extra });

// What the strip draws, read back as a line: a label is `[id]`, a seam `|` before whatever starts a new run.
const drawn = (tabs: readonly StripTab[]): string =>
    stripItems(tabs)
        .map((item) => `${item.seam ? `| ` : ``}${item.kind === `label` ? `[${item.group.id}]` : item.tab.id}`)
        .join(` `);

describe(`the strip's runs`, () => {
    test(`one unlabelled window is just its tabs, with no label and no seam`, () => {
        expect(drawn([tab(`a`), tab(`b`)])).toBe(`a b`);
    });

    test(`pins are set off from the web pages by a seam`, () => {
        expect(drawn([tab(`app`, { pinned: true }), tab(`a`), tab(`b`)])).toBe(`app | a b`);
    });

    test(`every window's run opens with its label, one per window, and each new run past the first gets a seam`, () => {
        const agent = group(`agent`);
        const own = group(`own`);
        expect(drawn([tab(`a1`, { group: agent }), tab(`a2`, { group: agent }), tab(`o1`, { group: own })])).toBe(`[agent] a1 a2 | [own] o1`);
    });

    test(`after the pins, the seam goes on the label rather than the tab it introduces`, () => {
        const agent = group(`agent`);
        const items = stripItems([tab(`desktop`, { pinned: true }), tab(`a1`, { group: agent })]);
        expect(items.map((item) => [item.kind, item.seam])).toEqual([
            [`tab`, false],
            [`label`, true],
            [`tab`, false],
        ]);
    });

    test(`a label's key is its window's, so a window keeps its label as tabs come and go`, () => {
        const own = group(`own`);
        const before = stripItems([tab(`opening`, { group: own })]);
        const after = stripItems([tab(`page:browser-own:p1`, { group: own })]);
        expect(before[0]?.key).toBe(`group:own`);
        expect(after[0]?.key).toBe(`group:own`);
    });
});

describe(`a window's initial`, () => {
    test(`is its name's first letter, upper-cased`, () => {
        expect(initialOf(`fix the login redirect`)).toBe(`F`);
        expect(initialOf(`Łódź trip planner`)).toBe(`Ł`);
    });

    test(`skips the punctuation and emoji a title may open with`, () => {
        expect(initialOf(`🚀 "Ship" the release`)).toBe(`S`);
        expect(initialOf(`#42 flaky test`)).toBe(`4`);
    });

    test(`is nothing for a name with no letter or digit`, () => {
        expect(initialOf(``)).toBeUndefined();
        expect(initialOf(`— …`)).toBeUndefined();
    });
});

describe(`a tab's key`, () => {
    test(`is its id, or the key it was given`, () => {
        const items = stripItems([tab(`a`), { ...tab(`b`), key: `opening:1` }]);
        expect(items.map((item) => item.key)).toEqual([`a`, `opening:1`]);
    });
});

describe(`a web page's tab between two addresses`, () => {
    const page = (extra: Partial<BrowserPage> = {}): BrowserPage => ({ id: `p1`, url: `http://192.168.0.103:9120/login`, active: true, ...extra });

    test(`turns while the page is on its way`, () => {
        expect(pageTabLook(page({ loading: true }))).toEqual({ note: `http://192.168.0.103:9120/login`, icon: `spinner`, spin: true });
    });

    test(`warns on the error page and says why on hover; turning wins over an error a new navigation is leaving`, () => {
        const failed = page({ url: `http://192.168.0.168/`, error: `net::ERR_CONNECTION_TIMED_OUT` });
        expect(pageTabLook(failed)).toEqual({
            note: `http://192.168.0.168/ · net::ERR_CONNECTION_TIMED_OUT`,
            icon: `exclamation-triangle`,
            tint: `text-warning`,
        });
        expect(pageTabLook({ ...failed, loading: true })).toMatchObject({ icon: `spinner`, spin: true });
    });

    test(`rests as the globe, as it always did against a daemon that says none of this, with no hover for no address`, () => {
        expect(pageTabLook(page())).toEqual({ note: `http://192.168.0.103:9120/login`, icon: `globe` });
        expect(pageTabLook(page({ url: `` }))).toEqual({ note: undefined, icon: `globe` });
    });
});
