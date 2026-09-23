import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import type { WorkspaceTreeEntry } from "@intentic/api-contract";
import { unstubbed } from "@intentic/testing";
import { parentDir } from "@intentic/ui/path";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { computed, effectScope, ref, shallowRef } from "vue";
import type { DroppedFile } from "../transfer/dropEntries";
import { useEntryDrag } from "../transfer/useEntryDrag";
import { IDLE, type InlineEdit } from "./inlineEdit";
import { indexEntries, type Row } from "./treeRows";
import { useTreeTransfer } from "./useTreeTransfer";

// Pins entries moving into, out of and around the tree: what cut and copy stage, where a paste lands and under which
// name, a row dragged onto a folder (a copy out of an archive), OS files dropped or pasted in, and an extract's landing.

const nameOf = (path: string): string => path.slice(path.lastIndexOf(`/`) + 1);
const dir = (path: string, children?: WorkspaceTreeEntry[]): WorkspaceTreeEntry => ({
    name: nameOf(path),
    path,
    type: `dir`,
    ...(children === undefined ? {} : { children }),
});
const file = (path: string): WorkspaceTreeEntry => ({ name: nameOf(path), path, type: `file` });
const row = (entry: WorkspaceTreeEntry): Row => ({ entry, depth: 0, isExpanded: false });
// `docs` is unlisted until something asks what it holds; the zip has been opened.
const TREE = [
    dir(`src`, [file(`src/main.ts`), file(`src/util.ts`)]),
    dir(`docs`),
    { ...file(`assets.zip`), children: [file(`assets.zip/logo.png`)] },
    file(`README.md`),
];
const LOCKED = `${STATE_DIR}/config/capabilities.json`;

const transferOver = () => {
    const lazy = new Map<string, readonly WorkspaceTreeEntry[]>();
    const childrenOf = (entry: WorkspaceTreeEntry): readonly WorkspaceTreeEntry[] => entry.children ?? lazy.get(entry.path) ?? [];
    const byPath = shallowRef(indexEntries(TREE, childrenOf));
    const calls: string[] = [];
    const store = {
        clipboard: shallowRef<{ readonly mode: "copy" | "cut"; readonly paths: readonly string[] } | undefined>(undefined),
        run: mock((task: () => Promise<void>, wrote: string): Promise<void> => {
            calls.push(`run: ${wrote}`);
            return task();
        }),
        copyEntries: mock((pairs: readonly { from: string; to: string }[]): Promise<void> => Promise.resolve()),
        moveIntoMany: mock((sources: readonly string[], targetDir: string): Promise<void> => Promise.resolve()),
        extractEntry: mock((path: string): Promise<string> => Promise.resolve(`docs/bundle`)),
        loadChildren: mock((path: string): Promise<void> => {
            lazy.set(path, [file(`${path}/main.ts`)]);
            return Promise.resolve();
        }),
    };
    const selecting = {
        selection: ref(new Set<string>()),
        lead: ref<string | null>(null),
        selectLanded: mock((paths: readonly string[]) => calls.push(`landed ${paths.join(`, `)}`)),
    };
    const edit = shallowRef<InlineEdit>(IDLE);
    const el = document.createElement(`div`);
    document.body.append(el);
    const uploads = { enqueue: mock((at: string, dropped: readonly DroppedFile[]) => Promise.resolve()), enqueueFromDataTransfer: mock() };
    const say = mock((message: string) => message);
    const transfer = effectScope().run(() =>
        useTreeTransfer({
            tree: () => TREE,
            rootDir: () => ``,
            byPath,
            childrenOf,
            targetDir: (path) => (path === null ? `` : byPath.value.get(path)?.type === `dir` ? path : parentDir(path)),
            openFolder: (at) => calls.push(`open ${at}`),
            rules: {
                unlockedOnly: (paths) => paths.filter((path) => path !== LOCKED),
                archived: (path) => path.startsWith(`assets.zip/`),
                noDrops: (at) => at === `${STATE_DIR}/secrets/auth` || at.startsWith(`assets.zip`),
                refuseIn: (at) => at === `readonly`,
            },
            selecting,
            inline: { edit, editing: computed(() => edit.value.kind !== `idle`) },
            el: ref(el),
            store,
            uploads,
            say,
        }),
    )!;
    return { transfer, store, selecting, edit, uploads, say, calls };
};
const select = (selecting: ReturnType<typeof transferOver>[`selecting`], paths: readonly string[]): void => {
    selecting.selection.value = new Set(paths);
    selecting.lead.value = paths.at(-1) ?? null;
};
// A clipboard event, carrying files or not; only what the tree reads is there.
const clipboardEvent = (files: readonly File[] = []) => {
    const setData = mock((format: string, text: string) => [format, text]);
    const preventDefault = mock();
    const clipboardData = unstubbed<DataTransfer>(`clipboardData`, { files: files as unknown as FileList, setData });
    return { event: unstubbed<ClipboardEvent>(`clipboardEvent`, { clipboardData, preventDefault }), setData, preventDefault };
};
// An OS drag: the platform's own, the one kind of drag a row reads natively.
const dragEvent = (types: readonly string[]) => {
    const dataTransfer = unstubbed<DataTransfer>(`dataTransfer`, { types, dropEffect: `none` });
    const preventDefault = mock();
    const stopPropagation = mock();
    return {
        event: unstubbed<DragEvent>(`dragEvent`, { dataTransfer, preventDefault, stopPropagation }),
        dataTransfer,
        preventDefault,
        stopPropagation,
    };
};
const writeText = mock((text: string) => Promise.resolve());
// Past every microtask a write chains, so what it does after its awaits has happened.
const drain = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    Object.defineProperty(navigator, `clipboard`, { configurable: true, value: { writeText } });
    writeText.mockClear();
});
afterEach(() => {
    window.dispatchEvent(new PointerEvent(`pointerup`));
    // jsdom has no layout, so a drag test names the element under the pointer outright; this takes that back.
    Reflect.deleteProperty(document, `elementFromPoint`);
    document.body.replaceChildren();
});

describe(`cut and copy`, () => {
    it(`stage what may move of the selection, or the lead alone, and the menu's also writes the paths as text`, () => {
        const { transfer, store, selecting } = transferOver();
        select(selecting, [`src/main.ts`, LOCKED]);
        expect([transfer.stage(`copy`, `event`), store.clipboard.value]).toEqual([[`src/main.ts`], { mode: `copy`, paths: [`src/main.ts`] }]);

        selecting.selection.value = new Set();
        selecting.lead.value = `README.md`;
        expect([transfer.stage(`cut`, `async`), store.clipboard.value, writeText.mock.calls]).toEqual([
            [`README.md`],
            { mode: `cut`, paths: [`README.md`] },
            [[`README.md`]],
        ]);

        selecting.lead.value = null;
        expect([transfer.stage(`copy`, `async`), store.clipboard.value, writeText.mock.calls.length]).toEqual([
            [],
            { mode: `cut`, paths: [`README.md`] },
            1,
        ]);
    });

    it(`answer the clipboard's own event with the paths as text, and leave it alone while a name is being typed`, () => {
        const { transfer, store, selecting, edit } = transferOver();
        select(selecting, [`src/main.ts`, `src/util.ts`]);

        const copied = clipboardEvent();
        transfer.onCopyEvent(copied.event, `copy`);
        expect([copied.setData.mock.calls, copied.preventDefault.mock.calls.length]).toEqual([[[`text/plain`, `src/main.ts\nsrc/util.ts`]], 1]);

        store.clipboard.value = undefined;
        edit.value = { kind: `renaming`, path: `src/main.ts` };
        const typing = clipboardEvent();
        transfer.onCopyEvent(typing.event, `cut`);
        expect([typing.setData.mock.calls, typing.preventDefault.mock.calls.length, store.clipboard.value]).toEqual([[], 0, undefined]);
    });
});

describe(`paste`, () => {
    it(`copies under a free name, reading an unlisted folder first, and selects what landed before it lands`, async () => {
        const { transfer, store, calls } = transferOver();
        store.clipboard.value = { mode: `copy`, paths: [`src/main.ts`] };

        await transfer.paste(`src`);
        await transfer.paste(`docs`);

        expect(store.copyEntries.mock.calls).toEqual([
            [[{ from: `src/main.ts`, to: `src/main copy.ts` }]],
            [[{ from: `src/main.ts`, to: `docs/main copy.ts` }]],
        ]);
        expect(store.loadChildren.mock.calls).toEqual([[`docs`]]);
        expect(calls).toEqual([
            `run: Couldn't paste those items.`,
            `open src`,
            `landed src/main copy.ts`,
            `run: Couldn't paste those items.`,
            `open docs`,
            `landed docs/main copy.ts`,
        ]);
        expect(store.clipboard.value).toEqual({ mode: `copy`, paths: [`src/main.ts`] });
    });

    it(`moves a cut, less what is already there, and spends the clipboard`, async () => {
        const { transfer, store, calls } = transferOver();
        store.clipboard.value = { mode: `cut`, paths: [`src/main.ts`, `README.md`] };

        await transfer.paste(`src`);

        expect([store.moveIntoMany.mock.calls, calls]).toEqual([
            [[[`README.md`], `src`]],
            [`run: Couldn't move those items.`, `open src`, `landed src/README.md`],
        ]);
        expect(store.clipboard.value).toBeUndefined();
    });

    it(`writes nothing into a refused folder, or with nothing staged`, async () => {
        const { transfer, store } = transferOver();
        await transfer.paste(`src`);
        store.clipboard.value = { mode: `copy`, paths: [`src/main.ts`] };
        await transfer.paste(`readonly`);

        expect([store.copyEntries.mock.calls, store.moveIntoMany.mock.calls]).toEqual([[], []]);
    });

    it(`takes OS files from a paste event into the lead's folder ahead of the tree's own clipboard`, () => {
        const { transfer, store, selecting, uploads, calls } = transferOver();
        select(selecting, [`src/main.ts`]);
        store.clipboard.value = { mode: `copy`, paths: [`README.md`] };
        const shot = new File([`png`], `shot.png`);
        Object.defineProperty(shot, `webkitRelativePath`, { value: `` });

        const pasted = clipboardEvent([shot]);
        transfer.onPasteEvent(pasted.event);

        expect([pasted.preventDefault.mock.calls.length, calls, uploads.enqueue.mock.calls]).toEqual([
            1,
            [`open src`],
            [[`src`, [{ file: shot, path: `shot.png` }]]],
        ]);
        expect(store.copyEntries.mock.calls).toEqual([]);
    });

    it(`pastes the tree's own clipboard from a paste event, and lets an event with nothing to paste through`, async () => {
        const { transfer, store, selecting } = transferOver();
        select(selecting, [`README.md`]);
        const idle = clipboardEvent();
        transfer.onPasteEvent(idle.event);

        store.clipboard.value = { mode: `copy`, paths: [`src/main.ts`] };
        const pasted = clipboardEvent();
        transfer.onPasteEvent(pasted.event);
        await drain();

        expect([idle.preventDefault.mock.calls.length, pasted.preventDefault.mock.calls.length, store.copyEntries.mock.calls]).toEqual([
            0,
            1,
            [[[{ from: `src/main.ts`, to: `main.ts` }]]],
        ]);
    });
});

describe(`a row dragged by pointer`, () => {
    // Press, travel past the threshold over an element offering `dir`, and optionally let go there.
    const dragTo = (
        transfer: ReturnType<typeof transferOver>[`transfer`],
        from: WorkspaceTreeEntry,
        at: string,
        press: PointerEventInit = {},
    ): void => {
        const target = document.createElement(`div`);
        target.dataset[`dropDir`] = at;
        document.elementFromPoint = () => target;
        transfer.onRowPointerDown(new PointerEvent(`pointerdown`, { button: 0, clientX: 10, clientY: 10, ...press }), row(from));
        window.dispatchEvent(new PointerEvent(`pointermove`, { cancelable: true, clientX: 60, clientY: 60 }));
    };

    it(`carries the whole selection from a selected row, and nothing from a modified press or the name field`, () => {
        const { transfer, selecting, edit } = transferOver();
        select(selecting, [`src/main.ts`, `src/util.ts`, LOCKED]);

        dragTo(transfer, file(`src/util.ts`), `docs`);
        expect([useEntryDrag().paths.value, transfer.carried(`src/main.ts`), transfer.carried(`README.md`), transfer.dropLit(`docs`)]).toEqual([
            [`src/main.ts`, `src/util.ts`],
            true,
            false,
            true,
        ]);
        window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape` }));

        dragTo(transfer, file(`src/util.ts`), `docs`, { altKey: true });
        edit.value = { kind: `renaming`, path: `README.md` };
        dragTo(transfer, file(`README.md`), `docs`);
        expect([useEntryDrag().dragging.value, transfer.carried(`src/util.ts`)]).toEqual([false, false]);
    });

    it(`moves a row onto the folder it is released over, and copies one out of an archive`, async () => {
        const { transfer, store, calls } = transferOver();

        dragTo(transfer, file(`README.md`), `src`);
        window.dispatchEvent(new PointerEvent(`pointerup`));
        dragTo(transfer, file(`assets.zip/logo.png`), `docs`);
        window.dispatchEvent(new PointerEvent(`pointerup`));
        await drain();

        expect([store.moveIntoMany.mock.calls, store.copyEntries.mock.calls]).toEqual([
            [[[`README.md`], `src`]],
            [[[{ from: `assets.zip/logo.png`, to: `docs/logo.png` }]]],
        ]);
        expect(calls).toEqual([`run: Couldn't move those items.`, `run: Couldn't copy those items out.`, `open docs`, `landed docs/logo.png`]);
    });
});

describe(`OS files dragged over a row`, () => {
    it(`light the folder the drop would land in, a file standing in for its parent, and never a private one`, () => {
        const { transfer } = transferOver();
        const over = dragEvent([`Files`]);
        transfer.onRowDragOver(over.event, row(file(`src/main.ts`)));
        expect([over.preventDefault.mock.calls.length, over.dataTransfer.dropEffect, transfer.dropLit(`src`)]).toEqual([1, `copy`, true]);

        const locked = dragEvent([`Files`]);
        transfer.onRowDragOver(locked.event, row(dir(`${STATE_DIR}/secrets/auth`)));
        expect([
            locked.preventDefault.mock.calls.length,
            locked.dataTransfer.dropEffect,
            transfer.dropLit(`src`),
            transfer.dropLit(`${STATE_DIR}/secrets/auth`),
        ]).toEqual([1, `none`, false, false]);

        transfer.onRowDragOver(dragEvent([`Files`]).event, row(file(`src/util.ts`)));
        transfer.onRowDragLeave(row(file(`README.md`)));
        expect(transfer.dropLit(`src`)).toBe(true);
        transfer.onRowDragLeave(row(dir(`src`)));
        expect(transfer.dropLit(`src`)).toBe(false);
    });

    it(`leave a drag carrying no files to the browser`, () => {
        const { transfer } = transferOver();
        const link = dragEvent([`text/uri-list`]);

        transfer.onRowDragOver(link.event, row(file(`src/main.ts`)));
        transfer.onRowDrop(link.event, row(file(`src/main.ts`)));
        expect([link.preventDefault.mock.calls.length, link.stopPropagation.mock.calls.length, transfer.dropLit(`src`)]).toEqual([0, 0, false]);
    });

    it(`upload into the folder dropped on, opened first, and a refused drop stops there and lands nothing`, () => {
        const { transfer, uploads, calls } = transferOver();
        const dropped = dragEvent([`Files`]);
        transfer.onRowDrop(dropped.event, row(file(`src/main.ts`)));
        const archived = dragEvent([`Files`]);
        transfer.onRowDrop(archived.event, row(file(`assets.zip/logo.png`)));

        expect([calls, uploads.enqueueFromDataTransfer.mock.calls]).toEqual([[`open src`], [[`src`, dropped.dataTransfer]]]);
        expect([archived.preventDefault.mock.calls.length, archived.stopPropagation.mock.calls.length]).toEqual([1, 1]);
    });
});

describe(`extracting an archive`, () => {
    it(`selects what it landed as, in the folder it landed in, and says so`, async () => {
        const { transfer, store, say, calls } = transferOver();

        await transfer.extract(`assets.zip`);

        expect([store.extractEntry.mock.calls, calls, say.mock.calls]).toEqual([
            [[`assets.zip`]],
            [`run: Couldn't extract that.`, `open docs`, `landed docs/bundle`],
            [[`Extracted to bundle`]],
        ]);
    });
});
