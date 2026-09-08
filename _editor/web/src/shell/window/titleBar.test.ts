// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { edgeBar, titleBarGesture, topRow } from "./titleBar";

/* The app's top row standing in for a title bar it no longer has (desktop-app windows.rs). Both rules are
 * about geometry the browser only has at runtime, so the pure halves are what is tested here: what a press on
 * the row means, and which bar the window's own buttons are about to cover. */

const rowOf = (markup: string): HTMLElement => {
    const row = document.createElement(`div`);
    row.innerHTML = markup;
    document.body.append(row);
    return row;
};

// jsdom lays nothing out, so the bar's distance from the top of the window is supplied the way the browser
// would have measured it.
const atTop = (): number => 0;

describe(`titleBarGesture`, () => {
    it(`drags the window from a bar's own background, and maximises on the second press`, () => {
        const row = rowOf(`<div class="view-header"><span id="air"></span></div>`);
        const air = row.querySelector(`#air`);

        expect(titleBarGesture(air, 1, atTop)).toBe(`drag`);
        expect(titleBarGesture(air, 2, atTop)).toBe(`maximize`);
    });

    /* THE ROW IS MOSTLY CONTROLS, and a press on one of them is that control's press. This is the rule that
     * decides whether the chat switcher opens or the window starts moving under the hand. */
    it(`leaves a press on anything in the bar to the thing it landed on`, () => {
        const row = rowOf(`
            <div class="view-header">
                <button id="tab"><span id="label">chat</span></button>
                <input id="rename" />
                <span id="opted-out" data-window-no-drag></span>
            </div>
        `);

        for (const id of [`#tab`, `#label`, `#rename`, `#opted-out`]) {
            expect(titleBarGesture(row.querySelector(id), 1, atTop), id).toBeUndefined();
        }
    });

    /* `.view-header` is worn by every bar in the app, not only the ones at the top of the window: the terminal
     * panel's sits at the bottom of the screen and an agent's detail row halfway down it. Dragging the whole
     * window by one of those is the bug this check exists for. */
    it(`ignores a bar that is not at the top of the window`, () => {
        const row = rowOf(`<div class="view-header"><span id="air"></span></div>`);

        expect(titleBarGesture(row.querySelector(`#air`), 1, () => 420)).toBeUndefined();
    });

    it(`is not a gesture at all away from the row`, () => {
        const row = rowOf(`<main><p id="prose">a paragraph</p></main>`);

        expect(titleBarGesture(row.querySelector(`#prose`), 1, atTop)).toBeUndefined();
        expect(titleBarGesture(null, 1, atTop)).toBeUndefined();
    });

    /* THE LOGIN PAGE HAS NO BAR, and a window that cannot be moved from its login screen is the bug this
     * exists for: the strip WindowControls draws across a bar-less top row is a title bar to the gesture, drag
     * and double-press alike. */
    it(`drags and maximises from the strip that stands in for a missing bar`, () => {
        const row = rowOf(`<div class="window-titlebar"></div>`);
        const strip = row.querySelector(`.window-titlebar`);

        expect(titleBarGesture(strip, 1, atTop)).toBe(`drag`);
        expect(titleBarGesture(strip, 2, atTop)).toBe(`maximize`);
    });
});

describe(`topRow`, () => {
    const bars = [
        { name: `explorer`, top: 0, right: 320 },
        { name: `editor`, top: 0.4, right: 1140 },
        { name: `chat`, top: 0, right: 1440 },
        { name: `terminal`, top: 700, right: 1440 },
        { name: `detail`, top: 236, right: 1140 },
    ];
    const edgesOf = (bar: (typeof bars)[number]): { top: number; right: number } => bar;

    /* The bars that wear the title fill are exactly the ones in the top row — a fraction of a pixel of
     * scaled-display rounding included — and never the terminal's or a detail row's, however much those look
     * like bars: a title fill halfway down the window is the failure this rule prevents. */
    it(`names every bar in the top row and none below it`, () => {
        expect(topRow(bars, edgesOf).map((bar) => bar.name)).toEqual([`explorer`, `editor`, `chat`]);
    });

    it(`is empty on a screen whose top row has no bar, which is when the strip stands in`, () => {
        expect(topRow([{ name: `login`, top: 96, right: 1440 }], edgesOf)).toEqual([]);
        expect(topRow([], edgesOf)).toEqual([]);
    });
});

describe(`edgeBar`, () => {
    const bars = [
        { name: `explorer`, top: 0, right: 320 },
        { name: `editor`, top: 0, right: 1140 },
        { name: `chat`, top: 0, right: 1440 },
        { name: `terminal`, top: 700, right: 1440 },
    ];
    const edgesOf = (bar: (typeof bars)[number]): { top: number; right: number } => bar;

    it(`finds the top row's bar at the window's right edge`, () => {
        expect(edgeBar(bars, edgesOf, 1440)?.name).toBe(`chat`);
    });

    /* The layout the reserve is easiest to get wrong in: the chat column is gone (popped out, or homed on the
     * rail), so the bar the buttons cover is the editor's tab row instead. Nothing declares that; the bar that
     * now ends at the window's edge is simply a different one. */
    it(`follows the layout when the right-hand column goes away`, () => {
        const withoutChat = bars.filter((bar) => bar.name !== `chat`).map((bar) => (bar.name === `editor` ? { ...bar, right: 1440 } : bar));

        expect(edgeBar(withoutChat, edgesOf, 1440)?.name).toBe(`editor`);
    });

    it(`reserves nothing on a screen whose top right corner has no bar`, () => {
        expect(edgeBar([{ name: `login`, top: 96, right: 1440 }], edgesOf, 1440)).toBeUndefined();
        expect(edgeBar([], edgesOf, 1440)).toBeUndefined();
    });
});
