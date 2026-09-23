import "@intentic/testing/dom";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { type App, createApp, h, nextTick, ref, shallowRef } from "vue";
import { IDLE, type InlineEdit } from "./inlineEdit";
import type { MoreRow, Row } from "./treeRows";
import { useTreeWindow } from "./useTreeWindow";

// Pins the rows the tree actually builds: a row's height is measured off the probe, the create field is allotted rows
// under its folder, only the rows crossing the viewport are painted, and a row is found, scrolled to and focused by path.
// A bare host component stands the composable up, since measuring on mount is part of what is pinned.

const file = (path: string): WorkspaceTreeEntry => ({ name: path, path, type: `file` });
const rowsOf = (count: number): Row[] => Array.from({ length: count }, (_, at) => ({ entry: file(`f${at}.ts`), depth: 0, isExpanded: false }));
// jsdom lays nothing out: an element's size is whatever the test says it is.
const sized = (tag: string, size: { readonly offsetHeight?: number; readonly clientHeight?: number }): HTMLElement => {
    const el = document.createElement(tag);
    for (const [key, value] of Object.entries(size)) {
        Object.defineProperty(el, key, { configurable: true, value });
    }
    document.body.append(el);
    return el;
};

let mounted: App | undefined;
const windowOver = (rows: readonly (Row | MoreRow)[], viewport = 100) => {
    const host = {
        rows: shallowRef(rows),
        lead: ref<string | null>(null),
        edit: shallowRef<InlineEdit>(IDLE),
        createError: ref<string | undefined>(undefined),
    };
    const scroller = sized(`div`, { clientHeight: viewport });
    let built: ReturnType<typeof useTreeWindow> | undefined;
    mounted = createApp({
        setup: () => {
            built = useTreeWindow(host);
            built.scroller.value = scroller;
            built.probeRow.value = sized(`div`, { offsetHeight: 20 });
            built.preamble.value = sized(`div`, { offsetHeight: 4 });
            return () => h(`div`);
        },
    });
    mounted.mount(document.createElement(`div`));
    return { host, win: built!, scroller };
};
const tops = (win: ReturnType<typeof useTreeWindow>): [string, number][] =>
    win.painted.value.map(({ row, top }) => [`more` in row ? row.key : row.entry.path, top]);

afterEach(() => {
    mounted?.unmount();
    mounted = undefined;
    document.body.replaceChildren();
});

describe(`the rows' geometry`, () => {
    it(`measures a row off the probe, and allots the create field a row under its folder, two with a refusal`, async () => {
        const { host, win } = windowOver(rowsOf(3));
        expect([win.rowHeight.value, win.treeHeight.value, tops(win)]).toEqual([
            20,
            60,
            [
                [`f0.ts`, 0],
                [`f1.ts`, 20],
                [`f2.ts`, 40],
            ],
        ]);

        host.edit.value = { kind: `creating`, dir: `f0.ts`, type: `file` };
        await nextTick();
        expect([win.createBlock.value, win.treeHeight.value, tops(win)[1]]).toEqual([20, 80, [`f1.ts`, 40]]);

        host.createError.value = `"a.ts" already exists.`;
        await nextTick();
        expect([win.createBlock.value, win.treeHeight.value, tops(win)[1]]).toEqual([40, 100, [`f1.ts`, 60]]);
    });

    it(`paints only the rows crossing the viewport, and a marker like any row`, () => {
        const rows = [...rowsOf(100), { more: 12, depth: 0, key: `#root-more` }];
        const { win } = windowOver(rows);

        expect([win.treeHeight.value, win.painted.value.length, tops(win).at(-1)]).toEqual([2020, 14, [`f13.ts`, 260]]);
    });
});

describe(`finding a row`, () => {
    it(`scrolls a row outside the window into it and answers its element, and answers nothing for a path with no row`, async () => {
        const { win } = windowOver(rowsOf(100));
        const far = document.createElement(`button`);
        win.setRowEl(`f60.ts`, far);

        expect(await win.showRow(`f60.ts`)).toBe(far);
        expect([tops(win)[0], tops(win).at(-1)]).toEqual([
            [`f48.ts`, 960],
            [`f69.ts`, 1380],
        ]);
        expect(await win.showRow(`nowhere.ts`)).toBeUndefined();

        win.setRowEl(`f60.ts`, null);
        expect(await win.showRow(`f60.ts`)).toBeUndefined();
    });

    it(`focuses the lead's row, and a clicked row by path`, async () => {
        const { host, win } = windowOver(rowsOf(3));
        const [first, last] = [sized(`button`, {}), sized(`button`, {})];
        win.setRowEl(`f0.ts`, first);
        win.setRowEl(`f2.ts`, last);

        host.lead.value = `f2.ts`;
        await win.focusLead();
        expect(document.activeElement).toBe(last);

        win.focusRow(`f0.ts`);
        expect(document.activeElement).toBe(first);
    });
});
