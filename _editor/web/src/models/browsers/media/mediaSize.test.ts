// The box castd sizes its screen to carries the ratio of the window the stage is in, which for a popped-out pane is
// not the editor's own: read off that window, watched there, and asked again when the stage moves to another.
import "@intentic/testing/dom";
import { mediaSize } from "./mediaSize";
import type { RatioWindow } from "./pixelRatio";

// A window of `ratio` device pixels per CSS pixel whose ratio media query can be made to change.
const fakeWindow = (ratio: number) => {
    const query = new EventTarget();
    let listening = 0;
    const view = {
        devicePixelRatio: ratio,
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
    } satisfies RatioWindow & { devicePixelRatio: number };
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
