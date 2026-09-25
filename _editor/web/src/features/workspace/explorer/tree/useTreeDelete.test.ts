import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import { nextTick } from "vue";
import { dir, emptyDirsOver, file, treeSurface } from "../../../../testing/treeSurface";
import { branchOf, sweepReceipt } from "./useTreeDelete";

// Pins deleting: straight to the trash with a receipt whose Undo holds exactly that delete, and the empty-folder line.

// `web/demo/assets` is one chain at the root; `src/old` sits under a folder with real content.
const BARREN = [`web`, `web/demo`, `web/demo/assets`, `src/old`];
const TREE = [dir(`web`, [dir(`web/demo`, [dir(`web/demo/assets`, [])])]), dir(`src`, [file(`src/main.ts`), dir(`src/old`, [])]), file(`README.md`)];
const drain = async (): Promise<void> => {
    for (let tick = 0; tick < 4; tick += 1) {
        await Promise.resolve();
    }
};

describe(`the sweep's receipt`, () => {
    const { emptyDirs } = emptyDirsOver(BARREN);

    it(`names a lone branch in full, root-level or buried, and counts several`, () => {
        expect(sweepReceipt([`web`], emptyDirs.chainOf)).toBe(`web / demo / assets removed`);
        expect(sweepReceipt([`src/old`], emptyDirs.chainOf)).toBe(`src / old removed`);
        expect(sweepReceipt([`web`, `src/old`], emptyDirs.chainOf)).toBe(`2 empty folders removed`);
    });

    it(`keeps a branch's staying ancestors apart from the chain that goes`, () => {
        expect([branchOf(`src/old`, emptyDirs.chainOf), branchOf(`web`, emptyDirs.chainOf)]).toEqual([
            { path: `src/old`, where: `src`, label: `old` },
            { path: `web`, where: ``, label: `web / demo / assets` },
        ]);
    });
});

describe(`deleting the selection`, () => {
    it(`deletes what may be deleted without asking, the receipt holding that delete for its Undo`, async () => {
        const { deleting, selecting, store, sayDeleted, select } = treeSurface(TREE, { barren: BARREN });
        select(`src/main.ts`, `${STATE_DIR}/config/capabilities.json`, `README.md`);

        deleting.requestDelete();
        expect([[...selecting.selection.value], store.removeEntries.mock.calls, store.run.mock.calls[0]?.[1]]).toEqual([
            [],
            [[[`src/main.ts`, `README.md`]]],
            `Couldn't delete that.`,
        ]);
        await drain();
        expect(sayDeleted.mock.calls).toEqual([
            [
                `2 items deleted`,
                {
                    entries: [
                        { path: `src/main.ts`, type: `file`, trashed: `trash:src/main.ts` },
                        { path: `README.md`, type: `file`, trashed: `trash:README.md` },
                    ],
                },
            ],
        ]);
    });

    it(`asks nothing and deletes nothing for a refused folder or an empty selection`, () => {
        const readOnly = treeSurface(TREE, { barren: BARREN, canWrite: false });
        readOnly.select(`README.md`);
        readOnly.deleting.requestDelete();

        const nothing = treeSurface(TREE, { barren: BARREN });
        nothing.select(`${STATE_DIR}/config/capabilities.json`);
        nothing.deleting.requestDelete();

        expect([readOnly.store.removeEntries.mock.calls, nothing.store.removeEntries.mock.calls]).toEqual([[], []]);
    });

    it(`reads a selection of empty folders as the sweep line does`, async () => {
        const { deleting, selecting, store, sayDeleted, select } = treeSurface(TREE, { barren: BARREN });
        select(`web`);

        deleting.requestDelete();
        await drain();
        expect([store.removeEntries.mock.calls, [...selecting.selection.value], sayDeleted.mock.calls[0]?.[0]]).toEqual([
            [[[`web`]]],
            [],
            `web / demo / assets removed`,
        ]);
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

        expect([writer.store.removeEntries.mock.calls, writer.sayDeleted.mock.calls[0]?.[0], reader.store.removeEntries.mock.calls]).toEqual([
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
