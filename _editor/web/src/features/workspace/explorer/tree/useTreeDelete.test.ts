import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import { nextTick } from "vue";
import { dir, emptyDirsOver, file, treeSurface } from "../../../../testing/treeSurface";
import { branchOf, sweepPlan } from "./useTreeDelete";

// Pins deleting: the confirm and its receipt, and the empty-folder line, which sweeps without asking and undoes exactly.

// `web/demo/assets` is one chain at the root; `src/old` sits under a folder with real content.
const BARREN = [`web`, `web/demo`, `web/demo/assets`, `src/old`];
const TREE = [dir(`web`, [dir(`web/demo`, [dir(`web/demo/assets`, [])])]), dir(`src`, [file(`src/main.ts`), dir(`src/old`, [])]), file(`README.md`)];
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
        const { deleting, selecting, store, say, select } = treeSurface(TREE, { barren: BARREN });
        select(`src/main.ts`, `${STATE_DIR}/config/capabilities.json`, `README.md`);

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
        const readOnly = treeSurface(TREE, { barren: BARREN, canWrite: false });
        readOnly.select(`README.md`);
        readOnly.deleting.requestDelete();

        const nothing = treeSurface(TREE, { barren: BARREN });
        nothing.select(`${STATE_DIR}/config/capabilities.json`);
        nothing.deleting.requestDelete();

        expect([readOnly.deleting.confirmPaths.value, nothing.deleting.confirmPaths.value, readOnly.store.removeEntries.mock.calls]).toEqual([
            undefined,
            undefined,
            [],
        ]);
    });

    it(`titles the confirm by what it names: one folder, one file, or a count`, () => {
        const { deleting, select } = treeSurface(TREE);
        select(`src`);
        deleting.requestDelete();
        const folder = deleting.deleteTitle.value;
        select(`README.md`);
        deleting.requestDelete();

        expect([folder, deleting.deleteTitle.value]).toEqual([`Delete folder?`, `Delete file?`]);
    });

    it(`sweeps a selection of empty folders without asking, and its Undo rebuilds them`, async () => {
        const { deleting, selecting, store, say, select } = treeSurface(TREE, { barren: BARREN });
        select(`web`);

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
        const { deleting, settled } = treeSurface(TREE, { barren: BARREN });
        expect([deleting.barrenBranches.value.map((branch) => branch.label), deleting.soleBarren.value]).toEqual([
            [`web / demo / assets`, `old`],
            undefined,
        ]);

        settled.value = [`src/old`];
        await nextTick();
        expect(deleting.soleBarren.value).toEqual({ path: `src/old`, where: `src`, label: `old` });
    });

    it(`folds its list closed and lets go of the pointed branch once they stop applying`, async () => {
        const { deleting, settled } = treeSurface(TREE, { barren: BARREN });
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
        const writer = treeSurface(TREE, { barren: BARREN });
        writer.deleting.sweepAll();
        await drain();
        const reader = treeSurface(TREE, { barren: BARREN, canWrite: false });
        reader.deleting.sweepAll();

        expect([writer.store.removeEntries.mock.calls, writer.say.mock.calls[0]?.[0], reader.store.removeEntries.mock.calls]).toEqual([
            [[[`web`, `src/old`]]],
            `2 empty folders removed`,
            [],
        ]);
    });

    it(`keeps a branch by dropping a placeholder into its deepest folder, refusing a read-only member`, async () => {
        const writer = treeSurface(TREE, { barren: BARREN });
        const reader = treeSurface(TREE, { barren: BARREN, canWrite: false });

        await writer.deleting.keepFolder(`web`);
        await reader.deleting.keepFolder(`web`);
        expect([writer.store.createFile.mock.calls, writer.say.mock.calls, reader.store.createFile.mock.calls]).toEqual([
            [[`web/demo/assets/.gitkeep`]],
            [[`Folder kept`]],
            [],
        ]);
    });
});
