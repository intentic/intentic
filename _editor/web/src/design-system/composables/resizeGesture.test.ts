import "@intentic/testing/dom";
import { afterResize, beginResizeGesture, layoutResizing, noteResizeMove, RESIZE_REST_MS, ResizeSeam } from "@intentic/ui";
import { numberPreference } from "@intentic/ui/preference";
import { createApp, h, nextTick, ref } from "vue";

// A drag of a resize handle draws its pane and nothing else on each frame. Pinned here: work that follows a pane's size
// waits for the drag and runs once (when the pointer rests or lets go), a dragged width is stored once, and a seam draws
// once a frame from the newest move, through its preview when it has one, writing its model once, on release.

const ticks = async (): Promise<void> => {
    await Promise.resolve();
    await nextTick();
};

describe(`afterResize`, () => {
    it(`runs the work at once when nothing is being dragged`, () => {
        const run = jest.fn();
        afterResize(run);
        expect(run).toHaveBeenCalledTimes(1);
        expect(layoutResizing.value).toBe(false);
    });

    it(`holds it through a drag and runs it once, on the tick after the drag ends`, async () => {
        const run = jest.fn();
        const end = beginResizeGesture();
        expect(layoutResizing.value).toBe(true);
        afterResize(run);
        afterResize(run);
        expect(run).not.toHaveBeenCalled();

        end();
        // After whatever the release committed has been drawn, not inside the release.
        expect(run).not.toHaveBeenCalled();
        await ticks();
        expect(run).toHaveBeenCalledTimes(1);
        expect(layoutResizing.value).toBe(false);
    });

    it(`lets it catch up once the pointer has rested, while the drag goes on`, () => {
        jest.useFakeTimers();
        try {
            const run = jest.fn();
            const end = beginResizeGesture();
            noteResizeMove();
            afterResize(run);
            jest.advanceTimersByTime(RESIZE_REST_MS - 1);
            // The pointer moved again before resting: the wait starts over.
            noteResizeMove();
            jest.advanceTimersByTime(RESIZE_REST_MS - 1);
            expect(run).not.toHaveBeenCalled();
            jest.advanceTimersByTime(1);
            expect(run).toHaveBeenCalledTimes(1);
            expect(layoutResizing.value).toBe(true);
            end();
        } finally {
            jest.useRealTimers();
        }
    });

    it(`drops work its caller took back, and ends a drag once however often it is ended`, async () => {
        const kept = jest.fn();
        const dropped = jest.fn();
        const end = beginResizeGesture();
        afterResize(kept);
        afterResize(dropped)();
        end();
        end();
        await ticks();
        expect(kept).toHaveBeenCalledTimes(1);
        expect(dropped).not.toHaveBeenCalled();
        expect(layoutResizing.value).toBe(false);
    });
});

// A seam mounted on its own, driven by pointer events, with the frame clock in the test's hands.
type Preview = (size: number | undefined) => void;
const mountSeam = (options: { readonly preview?: Preview; readonly previewProp?: { value: Preview | undefined }; readonly model?: { value: number } }) => {
    const frames: FrameRequestCallback[] = [];
    const { requestAnimationFrame: realFrame, cancelAnimationFrame: realCancel } = globalThis;
    globalThis.requestAnimationFrame = (callback) => frames.push(callback);
    globalThis.cancelAnimationFrame = (id) => {
        frames[id - 1] = () => {};
    };
    const model = options.model ?? ref(300);
    const writes: number[] = [];
    const app = createApp({
        setup: () => () =>
            h(ResizeSeam, {
                modelValue: model.value,
                "onUpdate:modelValue": (next: number) => {
                    writes.push(next);
                    model.value = next;
                },
                min: 200,
                max: 800,
                preview: options.previewProp === undefined ? options.preview : options.previewProp.value,
            }),
    });
    const host = document.createElement(`div`);
    document.body.append(host);
    app.mount(host);
    const seam = host.querySelector<HTMLElement>(`[role=separator]`)!;
    seam.setPointerCapture = () => {};
    seam.hasPointerCapture = () => false;
    const pointer = (type: string, x: number): void => {
        seam.dispatchEvent(new PointerEvent(type, { clientX: x, pointerId: 1, bubbles: true }));
    };
    const drawFrames = (): void => {
        for (const frame of frames.splice(0)) {
            frame(0);
        }
    };
    return {
        model,
        writes,
        frames,
        pointer,
        drawFrames,
        done: () => {
            app.unmount();
            host.remove();
            globalThis.requestAnimationFrame = realFrame;
            globalThis.cancelAnimationFrame = realCancel;
        },
    };
};

describe(`<ResizeSeam>`, () => {
    it(`draws once a frame, from the newest move`, () => {
        const seam = mountSeam({});
        try {
            seam.pointer(`pointerdown`, 100);
            seam.pointer(`pointermove`, 110);
            seam.pointer(`pointermove`, 125);
            expect(seam.frames).toHaveLength(1);
            expect(seam.writes).toEqual([]);
            seam.drawFrames();
            expect(seam.writes).toEqual([325]);
            seam.pointer(`pointerup`, 125);
            // The frame already drew where the pointer let go: nothing left to write.
            expect(seam.writes).toEqual([325]);
        } finally {
            seam.done();
        }
    });

    it(`with a preview, draws through it and writes the model once, where the pointer let go`, () => {
        const previews: (number | undefined)[] = [];
        const seam = mountSeam({ preview: (size) => previews.push(size) });
        try {
            seam.pointer(`pointerdown`, 100);
            seam.pointer(`pointermove`, 150);
            seam.drawFrames();
            seam.pointer(`pointermove`, 180);
            seam.drawFrames();
            seam.pointer(`pointermove`, 190);
            expect(seam.writes).toEqual([]);
            seam.pointer(`pointerup`, 190);
            // The last move had no frame of its own before the release, which still lands it, then lets the preview go.
            expect(previews).toEqual([350, 380, undefined]);
            expect(seam.writes).toEqual([390]);
        } finally {
            seam.done();
        }
    });

    it(`stores a dragged preference once, when the drag ends`, async () => {
        localStorage.clear();
        const stored: string[] = [];
        const setItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function (this: Storage, key: string, value: string): void {
            if (key.endsWith(`ui-test-seam-width`)) {
                stored.push(value);
            }
            setItem.call(this, key, value);
        };
        const width = numberPreference(`ui-test-seam-width`, (px) => px, () => 300);
        const seam = mountSeam({ model: width });
        try {
            seam.pointer(`pointerdown`, 100);
            for (const x of [110, 120, 130]) {
                seam.pointer(`pointermove`, x);
                seam.drawFrames();
                await nextTick();
            }
            // Worn at once, every frame.
            expect(width.value).toBe(330);
            expect(stored).toEqual([]);
            seam.pointer(`pointerup`, 130);
            expect(stored).toEqual([`330`]);
        } finally {
            Storage.prototype.setItem = setItem;
            seam.done();
        }
    });

    it(`tells the preview it started with that the drag ended, though the pane stopped asking for one mid-drag`, async () => {
        // The chat's edge previews only while the chat is alone in its panel; a tab opening beside it mid-drag takes the
        // preview away, and a preview never told the drag ended would draw its last width over the stored one for good.
        const previews: (number | undefined)[] = [];
        const previewProp = ref<Preview | undefined>((size) => previews.push(size));
        const seam = mountSeam({ previewProp });
        try {
            seam.pointer(`pointerdown`, 100);
            seam.pointer(`pointermove`, 150);
            seam.drawFrames();
            previewProp.value = undefined;
            await nextTick();
            seam.pointer(`pointerup`, 150);
            expect(previews).toEqual([350, undefined]);
            expect(seam.writes).toEqual([350]);
        } finally {
            seam.done();
        }
    });

    it(`ends its drag if it unmounts mid-drag, landing the size it was dragged to`, async () => {
        const previews: (number | undefined)[] = [];
        const seam = mountSeam({ preview: (size) => previews.push(size) });
        seam.pointer(`pointerdown`, 100);
        seam.pointer(`pointermove`, 140);
        expect(layoutResizing.value).toBe(true);
        seam.done();
        await ticks();
        // The move never had a frame drawn for it; unmounting lands it in the model and lets the preview go.
        expect(previews).toEqual([undefined]);
        expect(seam.writes).toEqual([340]);
        expect(layoutResizing.value).toBe(false);
    });
});
