import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { effectScope, nextTick, ref, shallowRef } from "vue";
import { indexEntries, type MoreRow, type Row } from "./treeRows";
import { useTreeReveal } from "./useTreeReveal";

// Pins how the open file is brought into view: every folder on the way (and the nest parent folding it) is opened, its
// row is shown once it exists, a row not built yet is retried as the rows change, and a shown path is left alone after.

const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const dir = (path: string, children?: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: nameOf(path),
    path,
    type: `dir`,
    ...(children === undefined ? {} : { children }),
});
const file = (path: string): WorkspaceTreeEntry => ({ name: nameOf(path), path, type: `file` });
const TREE = [dir(`src`, [dir(`src/api`, [file(`src/api/routes.ts`)]), file(`src/package.json`), file(`src/tsconfig.json`)]), file(`README.md`)];
const rowOf = (path: string): Row => ({ entry: file(path), depth: 0, isExpanded: false });

// `built` is the set of paths that have a row; showing one answers an element only once it does.
const revealOver = (opened: string | null | undefined, built: readonly string[], nesting = false) => {
    const selectedPath = ref(opened);
    const rows = shallowRef<readonly (Row | MoreRow)[]>(built.map(rowOf));
    const openAll = jest.fn((dirs: readonly string[]) => dirs.length);
    const showRow = jest.fn(async (path: string) =>
        rows.value.some((row) => !(`more` in row) && row.entry.path === path) ? document.createElement(`button`) : undefined,
    );
    effectScope().run(() =>
        useTreeReveal({
            selectedPath: () => selectedPath.value,
            rows,
            tree: () => TREE,
            byPath: shallowRef(indexEntries(TREE, (entry) => entry.children ?? [])),
            childrenOf: (entry) => entry.children ?? [],
            nesting: ref(nesting),
            openAll,
            showRow,
        }),
    );
    return { selectedPath, rows, openAll, showRow };
};
// Two ticks: the watch's own, then the one it awaits before showing the row.
const settle = async (): Promise<void> => {
    await nextTick();
    await nextTick();
};

describe(`revealing the open file`, () => {
    it(`opens the way down to it at once, then shows its row`, async () => {
        const { openAll, showRow } = revealOver(`src/api/routes.ts`, [`src`, `src/api`, `src/api/routes.ts`]);
        await settle();

        expect([openAll.mock.calls, showRow.mock.calls]).toEqual([[[[`src`, `src/api`]]], [[`src/api/routes.ts`]]]);
    });

    it(`opens the nest parent that folds it too, while nesting is on`, async () => {
        const { openAll } = revealOver(`src/tsconfig.json`, [`src/tsconfig.json`], true);
        await settle();

        expect(openAll.mock.calls).toEqual([[[`src`, `src/package.json`]]]);
    });

    it(`tries again when the rows change until its row exists, then leaves the path alone`, async () => {
        const { rows, openAll, showRow } = revealOver(`README.md`, []);
        await settle();
        expect(showRow.mock.calls).toEqual([[`README.md`]]);

        rows.value = [rowOf(`README.md`)];
        await settle();
        rows.value = [rowOf(`README.md`), rowOf(`src`)];
        await settle();

        expect([showRow.mock.calls, openAll.mock.calls.length]).toEqual([[[`README.md`], [`README.md`]], 2]);
    });

    it(`reveals nothing when no file is open, and a new one when it changes`, async () => {
        const { selectedPath, showRow } = revealOver(null, [`README.md`, `src`]);
        await settle();
        expect(showRow.mock.calls).toEqual([]);

        selectedPath.value = `src`;
        await settle();
        expect(showRow.mock.calls).toEqual([[`src`]]);
    });
});
