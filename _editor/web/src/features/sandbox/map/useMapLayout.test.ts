import "@intentic/testing/dom";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type App, createApp, h, nextTick, ref, watch } from "vue";
import { useMapLayout } from "./useMapLayout";

let app: App | undefined;
let frames: FrameRequestCallback[];

beforeEach(() => {
    frames = [];
    stubGlobal(`requestAnimationFrame`, (callback: FrameRequestCallback) => frames.push(callback));
});

afterEach(() => {
    app?.unmount();
    app = undefined;
    document.body.replaceChildren();
    unstubAllGlobals();
});

// The browser lays the box out in response to Vue's column choice. Its measured position follows the rendered DOM,
// not the width ref: reading it before Vue has patched the columns returns the previous arrangement.
const mountAt = (initialWidth: number) => {
    let availableWidth = initialWidth;
    let measured!: ReturnType<typeof useMapLayout>;
    const published: { width: number; left: number | undefined; top: number | undefined }[] = [];
    app = createApp({
        setup() {
            const stage = ref<HTMLElement>();
            measured = useMapLayout(stage, () => undefined);
            watch(measured.layout, (layout) => published.push({ width: layout.width, left: layout.box?.left, top: layout.box?.top }), { flush: `sync` });
            return () => h(`div`, { ref: stage, "data-across": measured.width.value >= 600 }, [h(`div`, { "data-map-box": `` })]);
        },
    });
    const host = document.createElement(`div`);
    document.body.append(host);
    app.mount(host);
    const stage = host.firstElementChild;
    const box = stage?.querySelector(`[data-map-box]`);
    if (!(stage instanceof HTMLElement) || !(box instanceof HTMLElement)) {
        throw new Error(`Map stage did not mount`);
    }
    stage.getBoundingClientRect = () => new DOMRect(0, 0, availableWidth, 600);
    box.getBoundingClientRect = () => (stage.dataset[`across`] === `true` ? new DOMRect(240, 28, 280, 300) : new DOMRect(0, 360, availableWidth, 240));
    return { measured, published, resize: (width: number) => (availableWidth = width) };
};

const paint = async () => {
    const pending = frames.splice(0);
    for (const callback of pending) {
        callback(0);
    }
    await nextTick();
};

it(`publishes the first geometry only after the width has placed the cards`, async () => {
    const { measured, published } = mountAt(800);
    expect(measured.layout.value.width).toBe(0);

    await paint();

    expect(published).toEqual([{ width: 800, left: 240, top: 28 }]);
});

it(`measures the new arrangement when resizing across the stacking breakpoint`, async () => {
    const { measured, published, resize } = mountAt(400);
    await paint();
    resize(800);
    measured.measure();
    measured.measure();
    expect(frames.length).toBe(1);
    await paint();
    resize(400);
    measured.measure();
    await paint();

    expect(published).toEqual([
        { width: 400, left: 0, top: 360 },
        { width: 800, left: 240, top: 28 },
        { width: 400, left: 0, top: 360 },
    ]);
});
