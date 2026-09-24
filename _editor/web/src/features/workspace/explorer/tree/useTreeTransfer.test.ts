import { STATE_DIR } from "@intentic/constants";
import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import { dir, file, treeSurface } from "../../../../testing/treeSurface";
import { useEntryDrag } from "../transfer/useEntryDrag";

// Pins entries moving into, out of and around a file surface: clipboard, pointer drags, OS files and an extract.

// `docs` is unlisted until something asks what it holds; the zip has been opened.
const TREE = [
    dir(`src`, [file(`src/main.ts`), file(`src/util.ts`)]),
    dir(`docs`),
    { ...file(`assets.zip`), children: [file(`assets.zip/logo.png`)] },
    file(`README.md`),
];
const LOCKED = `${STATE_DIR}/config/capabilities.json`;

// A clipboard event, carrying files or not; only what the surface reads is there.
const clipboardEvent = (files: readonly File[] = []) => {
    const setData = jest.fn((format: string, text: string) => [format, text]);
    const preventDefault = jest.fn();
    const clipboardData = unstubbed<DataTransfer>(`clipboardData`, { files: files as unknown as FileList, setData });
    return { event: unstubbed<ClipboardEvent>(`clipboardEvent`, { clipboardData, preventDefault }), setData, preventDefault };
};
// An OS drag: the platform's own, the one kind of drag an entry reads natively.
const dragEvent = (types: readonly string[]) => {
    const dataTransfer = unstubbed<DataTransfer>(`dataTransfer`, { types, dropEffect: `none` });
    const preventDefault = jest.fn();
    const stopPropagation = jest.fn();
    return {
        event: unstubbed<DragEvent>(`dragEvent`, { dataTransfer, preventDefault, stopPropagation, relatedTarget: null, currentTarget: null }),
        dataTransfer,
        preventDefault,
        stopPropagation,
    };
};
const writeText = jest.fn((text: string) => Promise.resolve());
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
        const { transfer, store, selecting, select } = treeSurface(TREE);
        select(`src/main.ts`, LOCKED);
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
        const { transfer, store, inline, select } = treeSurface(TREE);
        select(`src/main.ts`, `src/util.ts`);

        const copied = clipboardEvent();
        transfer.onCopyEvent(copied.event, `copy`);
        expect([copied.setData.mock.calls, copied.preventDefault.mock.calls.length]).toEqual([[[`text/plain`, `src/main.ts\nsrc/util.ts`]], 1]);

        store.clipboard.value = undefined;
        inline.edit.value = { kind: `renaming`, path: `src/main.ts` };
        const typing = clipboardEvent();
        transfer.onCopyEvent(typing.event, `cut`);
        expect([typing.setData.mock.calls, typing.preventDefault.mock.calls.length, store.clipboard.value]).toEqual([[], 0, undefined]);
    });
});

describe(`paste`, () => {
    it(`copies under a free name, reading an unlisted folder first, and opens and selects what landed before it lands`, async () => {
        const { transfer, store, selecting, calls, release } = treeSurface(TREE, { park: true });
        store.clipboard.value = { mode: `copy`, paths: [`src/main.ts`] };

        const pasting = transfer.paste(`docs`);
        await drain();
        expect([calls, [...store.expanded.value], [...selecting.selection.value]]).toEqual([
            [`list docs`, `run: Couldn't paste those items.`],
            [`docs`],
            [`docs/main copy.ts`],
        ]);
        release();
        await pasting;
        await transfer.paste(`src`);

        expect(store.copyEntries.mock.calls).toEqual([
            [[{ from: `src/main.ts`, to: `docs/main copy.ts` }]],
            [[{ from: `src/main.ts`, to: `src/main copy.ts` }]],
        ]);
        expect(store.clipboard.value).toEqual({ mode: `copy`, paths: [`src/main.ts`] });
    });

    it(`moves a cut, less what is already there, and spends the clipboard`, async () => {
        const { transfer, store, selecting } = treeSurface(TREE);
        store.clipboard.value = { mode: `cut`, paths: [`src/main.ts`, `README.md`] };

        await transfer.paste(`src`);

        expect([store.moveIntoMany.mock.calls, [...selecting.selection.value]]).toEqual([[[[`README.md`], `src`]], [`src/README.md`]]);
        expect(store.clipboard.value).toBeUndefined();
    });

    it(`opens the package.json a pasted file folds under, and not for a pasted folder`, async () => {
        const PACKAGE = [dir(`app`, [file(`app/package.json`)]), dir(`lib`, []), file(`README.md`)];
        const pasted = treeSurface(PACKAGE, { nesting: true });
        pasted.store.clipboard.value = { mode: `copy`, paths: [`README.md`] };
        await pasted.transfer.paste(`app`);
        const folder = treeSurface(PACKAGE, { nesting: true });
        folder.store.clipboard.value = { mode: `cut`, paths: [`lib`] };
        await folder.transfer.paste(`app`);

        expect([[...pasted.store.expanded.value], [...folder.store.expanded.value]]).toEqual([[`app`, `app/package.json`], [`app`]]);
    });

    it(`writes nothing with nothing staged, into an archive, or for a read-only member`, async () => {
        const writer = treeSurface(TREE);
        await writer.transfer.paste(`src`);
        writer.store.clipboard.value = { mode: `copy`, paths: [`src/main.ts`] };
        await writer.transfer.paste(`assets.zip`);
        const reader = treeSurface(TREE, { canWrite: false });
        reader.store.clipboard.value = { mode: `copy`, paths: [`src/main.ts`] };
        await reader.transfer.paste(`src`);

        expect([writer.store.copyEntries.mock.calls, writer.store.moveIntoMany.mock.calls, reader.store.copyEntries.mock.calls]).toEqual([
            [],
            [],
            [],
        ]);
    });

    it(`takes OS files from a paste event into the lead's folder ahead of the surface's own clipboard, but not into an archive`, () => {
        const { transfer, store, uploads, select } = treeSurface(TREE);
        select(`src/main.ts`);
        store.clipboard.value = { mode: `copy`, paths: [`README.md`] };
        const shot = new File([`png`], `shot.png`);
        Object.defineProperty(shot, `webkitRelativePath`, { value: `` });

        const pasted = clipboardEvent([shot]);
        transfer.onPasteEvent(pasted.event);
        select(`assets.zip/logo.png`);
        const archived = clipboardEvent([shot]);
        transfer.onPasteEvent(archived.event);

        expect([pasted.preventDefault.mock.calls.length, [...store.expanded.value], uploads.enqueue.mock.calls]).toEqual([
            1,
            [`src`],
            [[`src`, [{ file: shot, path: `shot.png` }]]],
        ]);
        expect([archived.preventDefault.mock.calls.length, store.actionError.value?.title, store.copyEntries.mock.calls]).toEqual([
            1,
            `An archive's contents are read-only. Extract it to change them.`,
            [],
        ]);
    });

    it(`pastes the surface's own clipboard from a paste event, and lets an event with nothing to paste through`, async () => {
        const { transfer, store, select } = treeSurface(TREE);
        select(`README.md`);
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

describe(`an entry dragged by pointer`, () => {
    // Press, travel past the threshold over an element offering `at`.
    const dragTo = (transfer: ReturnType<typeof treeSurface>[`transfer`], from: string, at: string, press: PointerEventInit = {}): void => {
        const target = document.createElement(`div`);
        target.dataset[`dropDir`] = at;
        document.elementFromPoint = () => target;
        transfer.onPointerDown(new PointerEvent(`pointerdown`, { button: 0, clientX: 10, clientY: 10, ...press }), from);
        window.dispatchEvent(new PointerEvent(`pointermove`, { cancelable: true, clientX: 60, clientY: 60 }));
    };

    it(`carries the whole selection from a selected entry, and nothing from a modified press or the name field`, () => {
        const { transfer, inline, select } = treeSurface(TREE);
        select(`src/main.ts`, `src/util.ts`, LOCKED);

        dragTo(transfer, `src/util.ts`, `docs`);
        expect([useEntryDrag().paths.value, transfer.carried(`src/main.ts`), transfer.carried(`README.md`), transfer.dropLit(`docs`)]).toEqual([
            [`src/main.ts`, `src/util.ts`],
            true,
            false,
            true,
        ]);
        window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape` }));

        dragTo(transfer, `src/util.ts`, `docs`, { altKey: true });
        inline.edit.value = { kind: `renaming`, path: `README.md` };
        dragTo(transfer, `README.md`, `docs`);
        expect([useEntryDrag().dragging.value, transfer.carried(`src/util.ts`)]).toEqual([false, false]);
    });

    it(`moves an entry onto the folder it is released over, and copies one out of an archive`, async () => {
        const { transfer, store, selecting, calls } = treeSurface(TREE);

        dragTo(transfer, `README.md`, `src`);
        window.dispatchEvent(new PointerEvent(`pointerup`));
        dragTo(transfer, `assets.zip/logo.png`, `docs`);
        window.dispatchEvent(new PointerEvent(`pointerup`));
        await drain();

        expect([store.moveIntoMany.mock.calls, store.copyEntries.mock.calls, [...store.expanded.value], [...selecting.selection.value]]).toEqual([
            [[[`README.md`], `src`]],
            [[[{ from: `assets.zip/logo.png`, to: `docs/logo.png` }]]],
            [`docs`],
            [`docs/logo.png`],
        ]);
        expect(calls.filter((call) => call.startsWith(`run: `))).toEqual([`run: Couldn't move those items.`, `run: Couldn't copy those items out.`]);
    });

    it(`opens the package.json an entry dragged into a package folder folds under, leaving the folder as it was`, async () => {
        const { transfer, store } = treeSurface([dir(`app`, [file(`app/package.json`)]), file(`README.md`)], { nesting: true });

        dragTo(transfer, `README.md`, `app`);
        window.dispatchEvent(new PointerEvent(`pointerup`));
        await drain();

        expect([store.moveIntoMany.mock.calls, [...store.expanded.value]]).toEqual([[[[`README.md`], `app`]], [`app/package.json`]]);
    });
});

describe(`OS files dragged over a folder`, () => {
    it(`light the folder the drop would land in, but never a private one or an archive's, and go dark when the drag ends`, () => {
        const { transfer } = treeSurface(TREE);
        const over = dragEvent([`Files`]);
        transfer.onDragOver(over.event, `src`);
        expect([
            over.preventDefault.mock.calls.length,
            over.stopPropagation.mock.calls.length,
            over.dataTransfer.dropEffect,
            transfer.dropLit(`src`),
        ]).toEqual([1, 1, `copy`, true]);

        const refused = [`${STATE_DIR}/secrets/auth`, `assets.zip`].map((at) => {
            const event = dragEvent([`Files`]);
            transfer.onDragOver(event.event, at);
            return [event.preventDefault.mock.calls.length, event.dataTransfer.dropEffect, transfer.dropLit(at)];
        });
        expect([refused, transfer.dropLit(`src`)]).toEqual([
            [
                [1, `none`, false],
                [1, `none`, false],
            ],
            false,
        ]);

        transfer.onDragOver(dragEvent([`Files`]).event, `src`);
        transfer.onDragLeave(dragEvent([`Files`]).event, `docs`);
        expect(transfer.dropLit(`src`)).toBe(true);
        transfer.onDragLeave(dragEvent([`Files`]).event, `src`);
        expect(transfer.dropLit(`src`)).toBe(false);

        transfer.onDragOver(dragEvent([`Files`]).event, `src`);
        window.dispatchEvent(new Event(`dragend`));
        expect(transfer.dropLit(`src`)).toBe(false);
    });

    it(`leave a drag carrying no files to the browser`, () => {
        const { transfer } = treeSurface(TREE);
        const link = dragEvent([`text/uri-list`]);

        transfer.onDragOver(link.event, `src`);
        transfer.onDrop(link.event, `src`);
        expect([link.preventDefault.mock.calls.length, link.stopPropagation.mock.calls.length, transfer.dropLit(`src`)]).toEqual([0, 0, false]);
    });

    it(`upload into the folder dropped on, opened first, and a refused drop stops there and lands nothing`, () => {
        const { transfer, store, uploads } = treeSurface(TREE);
        const dropped = dragEvent([`Files`]);
        transfer.onDrop(dropped.event, `src`);
        const archived = dragEvent([`Files`]);
        transfer.onDrop(archived.event, `assets.zip`);

        expect([[...store.expanded.value], uploads.enqueueFromDataTransfer.mock.calls]).toEqual([[`src`], [[`src`, dropped.dataTransfer]]]);
        expect([archived.preventDefault.mock.calls.length, archived.stopPropagation.mock.calls.length]).toEqual([1, 1]);
    });
});

describe(`extracting an archive`, () => {
    it(`selects what it landed as, in the folder it landed in, and says so`, async () => {
        const { transfer, store, selecting, say } = treeSurface(TREE);

        await transfer.extract(`assets.zip`);

        expect([store.extractEntry.mock.calls, [...store.expanded.value], [...selecting.selection.value], say.mock.calls]).toEqual([
            [[`assets.zip`]],
            [`docs`],
            [`docs/bundle`],
            [[`Extracted to bundle`]],
        ]);
    });
});
