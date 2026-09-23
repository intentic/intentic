import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { resetSandboxScope } from "@intentic/extension-api";
import { afterEach, describe, expect, it } from "bun:test";
import { effectScope, ref, shallowRef } from "vue";
import { noteArriving } from "../../files/provisionalEntries";
import { barrenChainOf, barrenChildren } from "../emptyDirs";
import type { Row } from "./treeRows";
import { useTreeRows } from "./useTreeRows";

// Pins the tree's reactive model: rows that follow the open set, the lazy listings, the switches and what this browser
// has just done; the index that reaches lazy rows; what a verb targets; what can expand; and how folders get opened.

const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const dir = (path: string, children?: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: nameOf(path),
    path,
    type: `dir`,
    ...(children === undefined ? {} : { children }),
});
const file = (path: string): WorkspaceTreeEntry => ({ name: nameOf(path), path, type: `file` });
const TREE = [dir(`src`, [dir(`src/api`), file(`src/main.ts`)]), file(`README.md`)];

// The model over `tree`, rooted at `rootDir`, with the store's open set and lazy listings as refs the test moves.
const rowsOver = (tree: readonly WorkspaceTreeEntry[], rootDir = ``, barren: readonly string[] = []) => {
    const store = {
        expanded: shallowRef<ReadonlySet<string>>(new Set()),
        lazyChildren: shallowRef(new Map<string, readonly WorkspaceTreeEntry[]>()),
        lazyHidden: shallowRef(new Map<string, number>()),
    };
    const switches = { showIgnored: ref(false), hideTests: ref(false), hideTechnical: ref(false) };
    const filter = ref(``);
    const model = effectScope().run(() =>
        useTreeRows({
            tree: () => tree,
            rootDir: () => rootDir,
            rootHidden: () => 0,
            filter: () => filter.value,
            switches,
            nesting: ref(false),
            store,
            emptyDirs: { isBarren: (path) => barren.includes(path), chainOf: (path) => barrenChainOf(path, barrenChildren(barren)) },
        }),
    )!;
    return { model, store, switches, filter };
};

afterEach(() => {
    resetSandboxScope();
});

describe(`the visible rows`, () => {
    it(`follow the open set, the lazy listing of an unlisted folder, and the filter box`, () => {
        const { model, store, filter } = rowsOver(TREE);
        expect(model.orderedPaths.value).toEqual([`src`, `README.md`]);

        store.expanded.value = new Set([`src`, `src/api`]);
        store.lazyChildren.value = new Map([[`src/api`, [file(`src/api/routes.ts`)]]]);
        store.lazyHidden.value = new Map([[`src/api`, 7]]);
        expect(model.orderedPaths.value).toEqual([`src`, `src/api`, `src/api/routes.ts`, `src/main.ts`, `README.md`]);
        expect(model.visibleRows.value[3]).toEqual({ more: 7, depth: 2, key: `src/api#more` });

        filter.value = `routes`;
        expect(model.orderedPaths.value).toEqual([`src`, `src/api`, `src/api/routes.ts`]);
    });

    it(`follow the toolbar's switches, and count what the technical one took out of the root`, () => {
        const { model, switches } = rowsOver([dir(`src`, []), file(`package.json`), file(`.gitignore`), file(`README.md`)]);
        expect([model.orderedPaths.value, model.technicalCount.value]).toEqual([[`src`, `package.json`, `.gitignore`, `README.md`], 0]);

        switches.hideTechnical.value = true;
        expect([model.orderedPaths.value, model.technicalCount.value]).toEqual([[`src`, `README.md`], 2]);
    });

    it(`draw what this browser has just written before the listing has it`, () => {
        noteArriving(`src/notes.md`, { kind: `write` });
        const { model, store } = rowsOver(TREE);
        store.expanded.value = new Set([`src`]);

        expect(model.orderedPaths.value).toEqual([`src`, `src/api`, `src/main.ts`, `src/notes.md`, `README.md`]);
    });
});

describe(`the index and a verb's folder`, () => {
    it(`indexes a lazily listed row, so it can be selected and acted on like any other`, () => {
        const { model, store } = rowsOver(TREE);
        store.lazyChildren.value = new Map([[`src/api`, [file(`src/api/routes.ts`)]]]);

        expect([...model.byPath.value.keys()]).toEqual([`src`, `src/api`, `src/api/routes.ts`, `src/main.ts`, `README.md`]);
        expect(model.childrenOf(dir(`src/api`))).toEqual([file(`src/api/routes.ts`)]);
    });

    it(`targets a folder itself, a file's parent, and with nothing to aim at the tree's own root`, () => {
        const { model } = rowsOver([dir(`app/src`, [file(`app/src/main.ts`)]), file(`app/README.md`)], `app`);

        expect([model.targetDir(`app/src`), model.targetDir(`app/src/main.ts`), model.targetDir(`app/README.md`), model.targetDir(null)]).toEqual([
            `app/src`,
            `app/src`,
            `app`,
            `app`,
        ]);
    });
});

describe(`what can expand`, () => {
    it(`is a folder, a nest or an archive, never a locked path or a dead link`, () => {
        const { model } = rowsOver([]);
        const row = (entry: WorkspaceTreeEntry, over: Partial<Row> = {}): Row => ({ entry, depth: 0, isExpanded: false, ...over });

        expect(
            [
                row(dir(`src`)),
                row(file(`package.json`), { nest: true }),
                row(file(`bundle.zip`)),
                row(file(`README.md`)),
                row(dir(`.intentic/secrets/auth`)),
                row({ ...dir(`away`), link: { to: `/etc`, state: `outside` } }),
            ].map(model.expandable),
        ).toEqual([true, true, true, false, false, false]);
    });

    it(`takes a barren chain as expandable only while its tail holds something`, () => {
        const barren = [`web`, `web/demo`, `web/demo/a`, `web/demo/b`];
        const web = dir(`web`, [dir(`web/demo`, [dir(`web/demo/a`, []), dir(`web/demo/b`, [])])]);
        const { model } = rowsOver([web], ``, barren);
        const chain: Row = { entry: web, depth: 0, isExpanded: false, barren: true, chain: [`web`, `demo`], chainTail: web.children?.[0] };
        const emptyTail: Row = { entry: dir(`web/demo/a`, []), depth: 1, isExpanded: false, barren: true };

        expect(model.visibleRows.value).toEqual([chain]);
        expect([model.expandable(chain), model.expandable(emptyTail)]).toEqual([true, false]);
    });
});

describe(`opening folders`, () => {
    it(`toggles one folder, and opens a landing folder only when closed and never the tree's own root`, () => {
        const { model, store } = rowsOver(TREE, `app`);

        model.toggleExpand(`src`);
        expect([...store.expanded.value]).toEqual([`src`]);
        model.toggleExpand(`src`);
        expect([...store.expanded.value]).toEqual([]);

        model.openFolder(`app`);
        model.openFolder(`src/api`);
        model.openFolder(`src/api`);
        expect([...store.expanded.value]).toEqual([`src/api`]);
    });

    it(`opens a whole way down at once, and writes nothing when it is already open`, () => {
        const { model, store } = rowsOver(TREE);
        model.openAll([`src`, `src/api`]);
        const opened = store.expanded.value;

        model.openAll([`src`]);
        expect([...store.expanded.value]).toEqual([`src`, `src/api`]);
        expect(store.expanded.value).toBe(opened);
    });
});
