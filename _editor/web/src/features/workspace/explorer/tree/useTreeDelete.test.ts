import { STATE_DIR } from "@intentic/constants";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { describe, expect, it, mock } from "bun:test";
import { computed, effectScope, nextTick, ref, shallowRef } from "vue";
import { barrenChainOf, barrenChildren, barrenRoots, branchDirPaths } from "../emptyDirs";
import { branchOf, sweepPlan, useTreeDelete } from "./useTreeDelete";

// Pins deleting from the tree: what the confirm is asked about and what its receipt says once the delete lands, and the
// empty-folder line, which names each branch, sweeps without a dialog, and whose Undo rebuilds exactly what went.

const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const dir = (path: string): WorkspaceTreeEntry => ({ name: nameOf(path), path, type: `dir`, children: [] });
const file = (path: string): WorkspaceTreeEntry => ({ name: nameOf(path), path, type: `file` });

// `web/demo/assets` is one chain at the root; `src/old` sits under a folder with real content.
const BARREN = [`web`, `web/demo`, `web/demo/assets`, `src/old`];
const emptyDirsOver = (barren: readonly string[]) => {
    const settled = shallowRef(barren);
    return {
        settled,
        emptyDirs: {
            isBarren: (path: string) => settled.value.includes(path),
            roots: computed(() => barrenRoots(settled.value, new Set(settled.value))),
            chainOf: (path: string) => barrenChainOf(path, barrenChildren(settled.value)),
            branchDirs: (root: string) => branchDirPaths(root, settled.value),
        },
    };
};

const deleteOver = (barren: readonly string[] = BARREN, canWrite = true) => {
    const { settled, emptyDirs } = emptyDirsOver(barren);
    const byPath = shallowRef(new Map([...BARREN.map(dir), dir(`src`), file(`src/main.ts`), file(`README.md`)].map((entry) => [entry.path, entry])));
    const selecting = {
        selection: ref(new Set<string>()),
        lead: ref<string | null>(null),
        selectSingle: mock((path: string) => {
            selecting.selection.value = new Set([path]);
        }),
        clear: mock(() => {
            selecting.selection.value = new Set();
        }),
    };
    const store = {
        run: mock((task: () => Promise<void>, wrote: string): Promise<void> => task()),
        removeEntries: mock((paths: readonly string[]): Promise<void> => Promise.resolve()),
        createDir: mock((path: string): Promise<void> => Promise.resolve()),
        createFile: mock((path: string): Promise<void> => Promise.resolve()),
        refuseWrite: mock(() => !canWrite),
    };
    const say = mock((message: string, undo?: () => void | Promise<void>) => [message, undo]);
    const openAll = mock((dirs: readonly string[]) => dirs.length);
    const showRow = mock(async (path: string) => (path === `` ? undefined : document.createElement(`button`)));
    const deleting = effectScope().run(() =>
        useTreeDelete({
            byPath,
            targetDir: (path) => (path === null ? `` : path.slice(0, Math.max(0, path.lastIndexOf(`/`)))),
            rules: {
                refuseIn: (at) => at === `locked` || !canWrite,
                unlockedOnly: (paths) => paths.filter((path) => path !== `${STATE_DIR}/config/capabilities.json`),
            },
            emptyDirs,
            selecting,
            store,
            say,
            openAll,
            showRow,
        }),
    )!;
    return { deleting, selecting, store, say, openAll, showRow, settled };
};
const pick = (selecting: ReturnType<typeof deleteOver>[`selecting`], paths: readonly string[]): void => {
    selecting.selection.value = new Set(paths);
    selecting.lead.value = paths.at(-1) ?? null;
};
const drain = async (): Promise<void> => {
    for (let tick = 0; tick < 4; tick += 1) {
        await Promise.resolve();
    }
};

describe(`the sweep's plan`, () => {
    const { emptyDirs } = emptyDirsOver(BARREN);

    it(`names a lone branch in full, root-level or buried, and counts several`, () => {
        expect(sweepPlan([`web`], emptyDirs).receipt).toBe(`web / demo / assets removed`);
        expect(sweepPlan([`src/old`], emptyDirs).receipt).toBe(`src / old removed`);
        expect(sweepPlan([`web`, `src/old`], emptyDirs).receipt).toBe(`2 empty folders removed`);
    });

    it(`recreates each chain's deepest folder on Undo, which brings back every one above it`, () => {
        expect(sweepPlan([`web`, `src/old`], emptyDirs).leaves).toEqual([`web/demo/assets`, `src/old`]);
    });

    it(`keeps a branch's staying ancestors apart from the chain that goes`, () => {
        expect([branchOf(`src/old`, emptyDirs.chainOf), branchOf(`web`, emptyDirs.chainOf)]).toEqual([
            { path: `src/old`, where: `src`, label: `old` },
            { path: `web`, where: ``, label: `web / demo / assets` },
        ]);
    });
});

describe(`deleting the selection`, () => {
    it(`asks first about what may be deleted, and deletes it only on the confirm, the receipt after`, async () => {
        const { deleting, selecting, store, say } = deleteOver();
        pick(selecting, [`src/main.ts`, `${STATE_DIR}/config/capabilities.json`, `README.md`]);

        deleting.requestDelete();
        expect([deleting.confirmPaths.value, deleting.deleteTitle.value, store.removeEntries.mock.calls]).toEqual([
            [`src/main.ts`, `README.md`],
            `Delete 2 items?`,
            [],
        ]);

        deleting.confirmDelete();
        expect([deleting.confirmPaths.value, [...selecting.selection.value], store.removeEntries.mock.calls, store.run.mock.calls[0]?.[1]]).toEqual([
            undefined,
            [],
            [[[`src/main.ts`, `README.md`]]],
            `Couldn't delete that.`,
        ]);
        await drain();
        expect(say.mock.calls).toEqual([[`2 items deleted`]]);
    });

    it(`asks nothing and deletes nothing for a refused folder or an empty selection`, () => {
        const readOnly = deleteOver(BARREN, false);
        pick(readOnly.selecting, [`README.md`]);
        readOnly.deleting.requestDelete();

        const nothing = deleteOver();
        pick(nothing.selecting, [`${STATE_DIR}/config/capabilities.json`]);
        nothing.deleting.requestDelete();

        expect([readOnly.deleting.confirmPaths.value, nothing.deleting.confirmPaths.value, readOnly.store.removeEntries.mock.calls]).toEqual([
            undefined,
            undefined,
            [],
        ]);
    });

    it(`titles the confirm by what it names: one folder, one file, or a count`, () => {
        const { deleting, selecting } = deleteOver([]);
        pick(selecting, [`src`]);
        deleting.requestDelete();
        const folder = deleting.deleteTitle.value;
        pick(selecting, [`README.md`]);
        deleting.requestDelete();

        expect([folder, deleting.deleteTitle.value]).toEqual([`Delete folder?`, `Delete file?`]);
    });

    it(`sweeps a selection of empty folders without asking, and its Undo rebuilds them`, async () => {
        const { deleting, selecting, store, say } = deleteOver();
        pick(selecting, [`web`]);

        deleting.requestDelete();
        await drain();
        expect([deleting.confirmPaths.value, store.removeEntries.mock.calls, [...selecting.selection.value]]).toEqual([undefined, [[[`web`]]], []]);

        const [receipt, undo] = say.mock.calls[0] ?? [];
        await undo?.();
        expect([receipt, store.createDir.mock.calls]).toEqual([`web / demo / assets removed`, [[`web/demo/assets`]]]);
    });
});

describe(`the empty-folder line`, () => {
    it(`names each branch, and one alone without a disclosure`, async () => {
        const { deleting, settled } = deleteOver();
        expect([deleting.barrenBranches.value.map((branch) => branch.label), deleting.soleBarren.value]).toEqual([
            [`web / demo / assets`, `old`],
            undefined,
        ]);

        settled.value = [`src/old`];
        await nextTick();
        expect(deleting.soleBarren.value).toEqual({ path: `src/old`, where: `src`, label: `old` });
    });

    it(`folds its list closed and lets go of the pointed branch once they stop applying`, async () => {
        const { deleting, settled } = deleteOver();
        deleting.sweepOpen.value = true;
        deleting.pointedBarren.value = `web`;

        settled.value = [`web`, `web/demo`, `web/demo/assets`];
        await nextTick();
        expect([deleting.sweepOpen.value, deleting.pointedBarren.value]).toEqual([false, `web`]);

        settled.value = [`src/old`];
        await nextTick();
        expect(deleting.pointedBarren.value).toBeUndefined();
    });

    it(`sweeps every branch it names on Clean up, refusing a read-only member`, async () => {
        const writer = deleteOver();
        writer.deleting.sweepAll();
        await drain();
        const reader = deleteOver(BARREN, false);
        reader.deleting.sweepAll();

        expect([writer.store.removeEntries.mock.calls, writer.say.mock.calls[0]?.[0], reader.store.removeEntries.mock.calls]).toEqual([
            [[[`web`, `src/old`]]],
            `2 empty folders removed`,
            [],
        ]);
    });

    it(`keeps a branch by dropping a placeholder into its deepest folder`, async () => {
        const { deleting, store, say } = deleteOver();

        await deleting.keepFolder(`web`);
        await deleting.keepFolder(`locked`);
        expect([store.createFile.mock.calls, say.mock.calls]).toEqual([[[`web/demo/assets/.gitkeep`]], [[`Folder kept`]]]);
    });

    it(`opens the way down to a named branch, selects it and brings its row on screen`, async () => {
        const { deleting, selecting, openAll, showRow, settled } = deleteOver();
        await deleting.revealBarren(`web/demo`);
        settled.value = [`src/old`];
        await nextTick();
        await deleting.revealSoleBarren();

        expect([openAll.mock.calls, [...selecting.selection.value], showRow.mock.calls]).toEqual([
            [[[`web`]], [[`src`]]],
            [`src/old`],
            [[`web/demo`], [`src/old`]],
        ]);
    });
});
