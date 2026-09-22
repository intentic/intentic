// The canvases live under two `v-if`s (the stage's `current?.running`, the picture's `kind === 'video'`), so the
// pane hands the sink `null` every time a browser stops or the picture path changes. Production caught this as
// "Cannot read properties of null (reading 'style')" from both `attach` and `close`.
import "@intentic/testing/dom";
import { it, expect } from "bun:test";
import { videoSink } from "./videoSink";

const canvas = (): HTMLCanvasElement => document.createElement(`canvas`);

it("takes canvases that have gone, and still hides the one it has", () => {
    const sink = videoSink(() => undefined);
    const still = canvas();
    still.style.visibility = `visible`;

    sink.attach(canvas(), still);
    expect(still.style.visibility).toBe(`hidden`);

    still.style.visibility = `visible`;
    // What the pane's watcher sends the moment the picture's `v-if` goes false.
    expect(() => sink.attach(null, null)).not.toThrow();
    expect(() => sink.close()).not.toThrow();
    // Detached: the sink has let go of it rather than kept painting into a canvas no longer on the page.
    expect(still.style.visibility).toBe(`visible`);
});

it("paints nothing once its canvases are null", () => {
    const sink = videoSink(() => undefined);
    sink.attach(canvas(), canvas());
    sink.attach(null, null);
    expect(() => sink.still(new Uint8Array([1, 2, 3]) as Uint8Array<ArrayBuffer>)).not.toThrow();
    expect(() => sink.push(new Uint8Array([1, 2, 3]), true, false)).not.toThrow();
});
