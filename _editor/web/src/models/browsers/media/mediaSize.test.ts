// The box castd sizes its screen to carries the ratio of the window the stage is in, which for a popped-out pane is
// not the editor's own: read off that window, watched there, and asked again when the stage moves to another. So does
// the rate that window's display refreshes at, said with the box once it is known.
import "@intentic/testing/dom";
import type { FrameWindow } from "./displayRate";
import { type MediaBox, mediaSize, type StageWindow } from "./mediaSize";

// A window of `ratio` device pixels per CSS pixel whose ratio media query can be made to change.
const fakeWindow = (ratio: number) => {
    const query = new EventTarget();
    let listening = 0;
    const view = {
        devicePixelRatio: ratio,
        // Its frames are never counted here: each test hands the rate it means.
        requestAnimationFrame: () => 0,
        matchMedia: () => ({
            addEventListener: (type: string, listener: EventListenerOrEventListenerObject): void => {
                listening += 1;
                query.addEventListener(type, listener);
            },
            removeEventListener: (type: string, listener: EventListenerOrEventListenerObject): void => {
                listening -= 1;
                query.removeEventListener(type, listener);
            },
        }),
    } satisfies StageWindow & { devicePixelRatio: number };
    return {
        view,
        listening: () => listening,
        change: (next: number) => {
            view.devicePixelRatio = next;
            query.dispatchEvent(new Event(`change`));
        },
    };
};

it("asks with the ratio of the stage's own window, and follows it there", async () => {
    const editor = fakeWindow(1);
    const popout = fakeWindow(2);
    let shown = editor;
    const sent: { width: number; height: number; scale: number }[] = [];
    const size = mediaSize(
        (box) => sent.push({ ...box }),
        () => true,
        () => shown.view,
        async () => undefined,
    );
    size.measured(800, 600);
    expect(sent.at(-1)).toEqual({ width: 800, height: 600, scale: 1 });
    // The pane pops out onto a screen of twice the density.
    shown = popout;
    size.moved();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent.at(-1)).toEqual({ width: 800, height: 600, scale: 2 });
    expect(editor.listening()).toBe(0);
    expect(popout.listening()).toBe(1);
    popout.change(3);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(sent.at(-1)).toEqual({ width: 800, height: 600, scale: 3 });
    size.dispose();
    expect(popout.listening()).toBe(0);
});

// A rate per window that the test settles when it likes.
const pendingRates = () => {
    const asked = new Map<FrameWindow, (hz: number | undefined) => void>();
    return {
        rate: (view: FrameWindow): Promise<number | undefined> => new Promise((resolve) => asked.set(view, resolve)),
        asked: () => asked.size,
        settle: async (view: FrameWindow, hz: number | undefined): Promise<void> => {
            asked.get(view)?.(hz);
            await Promise.resolve();
        },
    };
};

it("says the display's rate with the box, asking the same box again once the rate is known", async () => {
    const editor = fakeWindow(2);
    const rates = pendingRates();
    const sent: MediaBox[] = [];
    let may = false;
    const size = mediaSize((box) => sent.push(box), () => may, () => editor.view, rates.rate);
    // Nothing is measured before the stage has a size.
    expect(rates.asked()).toBe(0);
    size.measured(1200, 800);
    expect(rates.asked()).toBe(1);
    may = true;
    size.fresh();
    expect(sent).toEqual([{ width: 1200, height: 800, scale: 2 }]);
    await rates.settle(editor.view, 120);
    expect(sent).toEqual([
        { width: 1200, height: 800, scale: 2 },
        { width: 1200, height: 800, scale: 2, hz: 120 },
    ]);
    // A fresh socket hears it with the box from the start, and the window is not measured again.
    size.opened();
    size.fresh();
    expect(sent.at(-1)).toEqual({ width: 1200, height: 800, scale: 2, hz: 120 });
    expect(sent).toHaveLength(3);
    size.measured(1000, 800);
    expect(rates.asked()).toBe(1);
    size.dispose();
});

it("measures the rate of the window the stage moved to, and takes no late word from the one it left", async () => {
    const editor = fakeWindow(1);
    const popout = fakeWindow(1);
    let shown = editor;
    const rates = pendingRates();
    const sent: MediaBox[] = [];
    const size = mediaSize((box) => sent.push(box), () => true, () => shown.view, rates.rate);
    size.measured(800, 600);
    shown = popout;
    size.moved();
    expect(rates.asked()).toBe(2);
    await rates.settle(editor.view, 60);
    expect(sent.filter((box) => box.hz !== undefined)).toEqual([]);
    await rates.settle(popout.view, 144);
    expect(sent.at(-1)).toEqual({ width: 800, height: 600, scale: 1, hz: 144 });
    size.dispose();
});

it("asks castd no box until the socket may resize, whatever rate comes", async () => {
    const editor = fakeWindow(1);
    const rates = pendingRates();
    const sent: MediaBox[] = [];
    const size = mediaSize((box) => sent.push(box), () => false, () => editor.view, rates.rate);
    size.measured(800, 600);
    await rates.settle(editor.view, 60);
    expect(sent).toEqual([]);
    size.dispose();
});
