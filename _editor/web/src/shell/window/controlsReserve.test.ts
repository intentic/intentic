// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { barsChanged, cornerBar } from "./controlsReserve";

/* The bar that gives up its right end to the window's own buttons, and what that bar is re-measured on. */

describe(`cornerBar`, () => {
    // The buttons' box in a 1440-wide window: three 2.5rem buttons, 2.25rem tall, at the default text size.
    const CORNER = { left: 1320, bottom: 36 };
    // The terminal's bar reaches the right edge too, from the bottom of the window: only a bar meeting the corner counts.
    const bars = [
        { name: `explorer`, top: 0, bottom: 36, right: 320 },
        { name: `editor`, top: 0.4, bottom: 36.4, right: 1140 },
        { name: `terminal`, top: 700, bottom: 736, right: 1440 },
        { name: `chat`, top: 0, bottom: 36, right: 1440 },
    ];
    const edgesOf = (bar: (typeof bars)[number]): { top: number; bottom: number; right: number } => bar;

    it(`finds the top row's bar at the window's right edge`, () => {
        expect(cornerBar(bars, edgesOf, CORNER)?.name).toBe(`chat`);
    });

    /* The layout the reserve is easiest to get wrong in: the chat column is gone (popped out, or homed on the rail). */
    it(`follows the layout when the right-hand column goes away`, () => {
        const withoutChat = bars.filter((bar) => bar.name !== `chat`).map((bar) => (bar.name === `editor` ? { ...bar, right: 1440 } : bar));

        expect(cornerBar(withoutChat, edgesOf, CORNER)?.name).toBe(`editor`);
    });

    /* A page's title row starts a padding below the top edge and ends a padding short of it, and its actions still run under the buttons. */
    it(`finds a page's title row that runs into the corner without reaching either edge`, () => {
        expect(cornerBar([{ name: `page title`, top: 24, bottom: 60, right: 1416 }], edgesOf, CORNER)?.name).toBe(`page title`);
        expect(cornerBar([{ name: `page title`, top: 36, bottom: 72, right: 1416 }], edgesOf, CORNER)).toBeUndefined();
    });

    /* A `content` page is centred well short of the corner, and a title row scrolled away is not in it either. */
    it(`leaves a title row that stops short of the corner, or has scrolled out of view`, () => {
        expect(cornerBar([{ name: `page title`, top: 24, bottom: 60, right: 1168 }], edgesOf, CORNER)).toBeUndefined();
        expect(cornerBar([{ name: `page title`, top: -80, bottom: -44, right: 1416 }], edgesOf, CORNER)).toBeUndefined();
    });

    /* Two rows can run into the corner at once; the one whose controls end there is the one reaching furthest. */
    it(`prefers the bar reaching furthest into the corner`, () => {
        const both = [
            { name: `page title`, top: 24, bottom: 60, right: 1416 },
            { name: `chat`, top: 0, bottom: 36, right: 1440 },
        ];

        expect(cornerBar(both, edgesOf, CORNER)?.name).toBe(`chat`);
    });

    it(`reserves nothing on a screen whose top right corner has no bar`, () => {
        expect(cornerBar([{ name: `login`, top: 96, bottom: 132, right: 1440 }], edgesOf, CORNER)).toBeUndefined();
        expect(cornerBar([], edgesOf, CORNER)).toBeUndefined();
    });
});

/* WHAT THE CORNER IS RE-MEASURED ON. Every view arrives through a dynamic import, so its bars land after the click and
   the route change that asked for them; a bar that paints before it is measured paints its own right-end controls
   under the window's buttons. */
describe(`barsChanged`, () => {
    // Real records off a real observer: a hand-built MutationRecord would only prove the shape this file invented.
    const recordsOf = (mutate: (view: HTMLElement) => void): MutationRecord[] => {
        const view = document.createElement(`section`);
        document.body.append(view);
        const observer = new MutationObserver(() => {});
        observer.observe(document.body, { childList: true, subtree: true });
        mutate(view);
        const records = observer.takeRecords();
        observer.disconnect();
        view.remove();
        return records;
    };

    it(`sees a bar that arrived inside a view, which is how every bar arrives`, () => {
        const records = recordsOf((view) => {
            view.innerHTML = `<div class="ws"><div class="view-header">file tabs</div><div class="pane"></div></div>`;
        });

        expect(barsChanged(records)).toBe(true);
    });

    it(`sees a bar that left with the view it belonged to`, () => {
        const records = recordsOf((view) => {
            view.innerHTML = `<div class="ws"><div class="view-header">file tabs</div></div>`;
            view.replaceChildren();
        });

        expect(barsChanged(records)).toBe(true);
    });

    /* THE CHEAP ANSWER IS THE COMMON ONE: a chat streaming tokens mutates the document constantly, and none of it moves a bar. */
    it(`ignores churn that brought no bar with it`, () => {
        const records = recordsOf((view) => {
            view.append(document.createTextNode(`a token`));
            view.insertAdjacentHTML(`beforeend`, `<p class="message">and another</p>`);
        });

        expect(records.length).toBeGreaterThan(0);
        expect(barsChanged(records)).toBe(false);
    });
});
