import "@intentic/testing/dom";
import { unstubbed } from "@intentic/testing";
import { effectScope } from "vue";

// Pins the floor of a file surface: OS files dropped where no row took them land in its root, a surface that takes no
// files still keeps the platform from opening them, and a drag the page started itself is never read as files.

const uploads = { enqueueFromDataTransfer: jest.fn((dir: string, dataTransfer: DataTransfer) => [dir, dataTransfer]) };
jest.mock(`../../files/upload/useUploadQueue`, () => ({ useUploadQueue: () => uploads }));
const { useRootDrop } = await import(`./useRootDrop`);

// An OS drag as the surface reads it: what it offers, and what the surface answers.
const dragEvent = (types: readonly string[] = [`Files`]) => {
    const dataTransfer = unstubbed<DataTransfer>(`dataTransfer`, { types, dropEffect: `none` });
    const preventDefault = jest.fn();
    return { event: unstubbed<DragEvent>(`dragEvent`, { dataTransfer, preventDefault }), dataTransfer, preventDefault };
};

const surface = (options: { accepts?: () => boolean; refuse?: () => boolean } = {}) => {
    const scope = effectScope();
    const drop = scope.run(() => useRootDrop({ targetDir: () => `projects/shop`, ...options }))!;
    return { drop, scope };
};

let stop: (() => void) | undefined;
afterEach(() => {
    stop?.();
    stop = undefined;
    // A drag a test started in the page ends, as the platform ends one.
    window.dispatchEvent(new Event(`dragend`));
    uploads.enqueueFromDataTransfer.mockClear();
});

describe(`a surface that takes files`, () => {
    it(`draws its hint, answers copy, and lands a drop in its root`, () => {
        const { drop, scope } = surface();
        stop = () => scope.stop();
        const entering = dragEvent();
        drop.onRootDragEnter(entering.event);
        const over = dragEvent();
        drop.onRootDragOver(over.event);
        const hinted = drop.rootDragging.value;
        const dropped = dragEvent();
        drop.onRootDrop(dropped.event);
        expect([hinted, over.preventDefault.mock.calls.length, over.dataTransfer.dropEffect]).toEqual([true, 1, `copy`]);
        expect([dropped.preventDefault.mock.calls.length, drop.rootDragging.value, uploads.enqueueFromDataTransfer.mock.calls]).toEqual([
            1,
            false,
            [[`projects/shop`, dropped.dataTransfer]],
        ]);
    });

    it(`keeps its hint while the pointer crosses into a child, and drops it on the real exit`, () => {
        const { drop, scope } = surface();
        stop = () => scope.stop();
        drop.onRootDragEnter(dragEvent().event);
        drop.onRootDragEnter(dragEvent().event);
        drop.onRootDragLeave();
        const crossing = drop.rootDragging.value;
        drop.onRootDragLeave();
        expect([crossing, drop.rootDragging.value]).toEqual([true, false]);
    });

    it(`clears its hint when a row took the drop, since the window hears every drop before the row stops it`, () => {
        const { drop, scope } = surface();
        stop = () => scope.stop();
        drop.onRootDragEnter(dragEvent().event);
        window.dispatchEvent(new Event(`drop`));
        expect(drop.rootDragging.value).toBe(false);
    });

    it(`lets its last word refuse a drop, and lands nothing`, () => {
        const refuse = jest.fn(() => true);
        const { drop, scope } = surface({ refuse });
        stop = () => scope.stop();
        const dropped = dragEvent();
        drop.onRootDrop(dropped.event);
        expect([refuse.mock.calls.length, dropped.preventDefault.mock.calls.length, uploads.enqueueFromDataTransfer.mock.calls]).toEqual([1, 1, []]);
    });
});

describe(`a surface that takes no files`, () => {
    it(`says no with the cursor, draws no hint, and still keeps the platform from opening the file`, () => {
        const { drop, scope } = surface({ accepts: () => false });
        stop = () => scope.stop();
        drop.onRootDragEnter(dragEvent().event);
        const over = dragEvent();
        drop.onRootDragOver(over.event);
        const dropped = dragEvent();
        drop.onRootDrop(dropped.event);
        expect([drop.rootDragging.value, over.preventDefault.mock.calls.length, over.dataTransfer.dropEffect]).toEqual([false, 1, `none`]);
        expect([dropped.preventDefault.mock.calls.length, uploads.enqueueFromDataTransfer.mock.calls]).toEqual([1, []]);
    });
});

describe(`a drag that is not files from outside`, () => {
    it(`is left alone when the page started it, though it is typed as files`, () => {
        const { drop, scope } = surface();
        stop = () => scope.stop();
        window.dispatchEvent(new Event(`dragstart`));
        drop.onRootDragEnter(dragEvent().event);
        const over = dragEvent();
        drop.onRootDragOver(over.event);
        drop.onRootDrop(dragEvent().event);
        expect([drop.rootDragging.value, over.dataTransfer.dropEffect, uploads.enqueueFromDataTransfer.mock.calls]).toEqual([false, `none`, []]);
    });

    it(`is left alone when it carries no files at all`, () => {
        const { drop, scope } = surface();
        stop = () => scope.stop();
        drop.onRootDragEnter(dragEvent([`text/plain`]).event);
        drop.onRootDrop(dragEvent([`text/plain`]).event);
        expect([drop.rootDragging.value, uploads.enqueueFromDataTransfer.mock.calls]).toEqual([false, []]);
    });
});
