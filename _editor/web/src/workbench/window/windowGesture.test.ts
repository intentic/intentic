import "@intentic/testing/dom";
import { type Layout, type Press, pressOf, windowGesture } from "./windowGesture";

/* The page as the frameless window's handle (desktop-app windows.rs): what a press moves, and what it leaves alone. */

const BAND = 36;

const mount = (markup: string): HTMLElement => {
    document.body.innerHTML = markup;
    return document.body;
};

// jsdom lays nothing out, so what a layout would say is supplied per test; whatever is not supplied reads as "nothing there".
const layoutOf = (facts: Partial<Layout> = {}): Layout => ({
    band: BAND,
    styleOf: () => ({ cursor: `auto`, userSelect: `auto`, position: `static` }),
    onScrollbar: () => false,
    onTextLine: () => false,
    ...facts,
});

const pressOn = (target: EventTarget | null, y: number, rest: Partial<Press> = {}): Press => ({
    target,
    x: 100,
    y,
    clicks: 1,
    modified: false,
    ...rest,
});

describe(`the title band`, () => {
    it(`drags the window from any background along the top edge, and maximises on the second click`, () => {
        const air = mount(`<main><div id="air"></div></main>`).querySelector(`#air`);

        expect(windowGesture(pressOn(air, 4), layoutOf())).toBe(`drag`);
        expect(windowGesture(pressOn(air, 4, { clicks: 2 }), layoutOf())).toBe(`maximize`);
    });

    /* A title reads as part of the bar it is in: a press on a bar's label moves the window, as it would on any title bar. */
    it(`drags from a line of text in the band, the way a title bar's own title does`, () => {
        const label = mount(`<div class="view-header"><span id="label">Agents</span></div>`).querySelector(`#label`);

        expect(windowGesture(pressOn(label, 12), layoutOf({ onTextLine: () => true }))).toBe(`drag`);
    });

    it(`is exactly as tall as the window's own buttons`, () => {
        const text = mount(`<p id="text">a line</p>`).querySelector(`#text`);
        const onText = layoutOf({ onTextLine: () => true });

        expect(windowGesture(pressOn(text, BAND), onText)).toBe(`drag`);
        expect(windowGesture(pressOn(text, BAND + 1), onText)).toBeUndefined();
    });
});

describe(`the background`, () => {
    it(`drags the window from an empty stretch below the band`, () => {
        const canvas = mount(`<main><section id="canvas"><p>Ask anything.</p></section></main>`).querySelector(`#canvas`);

        expect(windowGesture(pressOn(canvas, 400), layoutOf())).toBe(`drag`);
    });

    /* A press on a line of text anchors a selection, and a selection started from the margin of the line is still a selection. */
    it(`leaves a line of text to the selection the press would start`, () => {
        const prose = mount(`<article id="prose"><p>a paragraph</p></article>`).querySelector(`#prose`);

        expect(windowGesture(pressOn(prose, 400), layoutOf({ onTextLine: () => true }))).toBeUndefined();
    });

    it(`drags from text nobody can select`, () => {
        const badge = mount(`<div id="badge" class="select-none">ACTIVE</div>`).querySelector(`#badge`);
        const unselectable = layoutOf({
            styleOf: () => ({ cursor: `auto`, userSelect: `none`, position: `static` }),
            onTextLine: () => true,
        });

        expect(windowGesture(pressOn(badge, 400), unselectable)).toBe(`drag`);
    });

    /* Shift extends a selection; none of the others means "move the window" either. */
    it(`is never a gesture with a modifier held`, () => {
        const air = mount(`<div id="air"></div>`).querySelector(`#air`);

        expect(windowGesture(pressOn(air, 4, { modified: true }), layoutOf())).toBeUndefined();
        expect(windowGesture(pressOn(air, 400, { modified: true }), layoutOf())).toBeUndefined();
    });
});

describe(`what a press is for first`, () => {
    it(`leaves a control to itself, wherever in it the press landed`, () => {
        const row = mount(`
            <div class="view-header">
                <button id="tab"><span id="label">chat</span></button>
                <input id="rename" />
                <a id="link" href="/agents">agents</a>
                <label id="field">name</label>
                <details><summary id="summary">more</summary></details>
                <div id="role-tab" role="tab"></div>
                <div id="card" role="button"></div>
                <div id="focusable" tabindex="0"></div>
                <div id="dragged" draggable="true"></div>
                <div id="editable" contenteditable="true"></div>
                <div id="opted-out" data-window-no-drag></div>
            </div>
        `);

        for (const id of [
            `#tab`,
            `#label`,
            `#rename`,
            `#link`,
            `#field`,
            `#summary`,
            `#role-tab`,
            `#card`,
            `#focusable`,
            `#dragged`,
            `#editable`,
            `#opted-out`,
        ]) {
            expect(windowGesture(pressOn(row.querySelector(id), 4), layoutOf()), id).toBeUndefined();
            expect(windowGesture(pressOn(row.querySelector(id), 400), layoutOf()), id).toBeUndefined();
        }
    });

    /* `tabindex="-1"` marks a container focused by script — the file tree, a scroller — not a control. */
    it(`still drags from a container focused by script`, () => {
        const tree = mount(`<div id="tree" tabindex="-1"></div>`).querySelector(`#tree`);

        expect(windowGesture(pressOn(tree, 400), layoutOf())).toBe(`drag`);
    });

    it(`leaves another document, a picture and a glyph alone`, () => {
        const view = mount(`
            <div>
                <iframe id="frame"></iframe>
                <img id="picture" alt="" />
                <svg id="glyph"><path id="stroke"></path></svg>
                <canvas id="canvas"></canvas>
            </div>
        `);

        for (const id of [`#frame`, `#picture`, `#glyph`, `#stroke`, `#canvas`]) {
            expect(windowGesture(pressOn(view.querySelector(id), 4), layoutOf()), id).toBeUndefined();
        }
    });

    /* A menu, a dialog and its mask, the notification lane and the window's own buttons are all fixed to the viewport. */
    it(`leaves a press inside an overlay to the overlay`, () => {
        const view = mount(`<div id="menu"><div id="row"><span id="air"></span></div></div>`);
        const menu = view.querySelector(`#menu`);
        const overlaid = layoutOf({
            styleOf: (element) => ({ cursor: `auto`, userSelect: `auto`, position: element === menu ? `fixed` : `static` }),
        });

        expect(windowGesture(pressOn(view.querySelector(`#air`), 4), overlaid)).toBeUndefined();
        expect(windowGesture(pressOn(view.querySelector(`#air`), 400), overlaid)).toBeUndefined();
    });

    /* A pointer, an I-beam, a grab hand, a resize arrow: each names what the press is for, and none of it is the window. */
    it(`yields to any cursor that names another gesture`, () => {
        const air = mount(`<div id="air"></div>`).querySelector(`#air`);

        for (const cursor of [`pointer`, `text`, `grab`, `col-resize`, `row-resize`, `move`, `crosshair`, `not-allowed`]) {
            const under = layoutOf({ styleOf: () => ({ cursor, userSelect: `auto`, position: `static` }) });
            expect(windowGesture(pressOn(air, 4), under), cursor).toBeUndefined();
            expect(windowGesture(pressOn(air, 400), under), cursor).toBeUndefined();
        }
    });

    it(`leaves a scrollbar to scrolling, in the band too`, () => {
        const scroller = mount(`<div id="scroller"></div>`).querySelector(`#scroller`);
        const onBar = layoutOf({ onScrollbar: () => true });

        expect(windowGesture(pressOn(scroller, 4), onBar)).toBeUndefined();
        expect(windowGesture(pressOn(scroller, 400), onBar)).toBeUndefined();
    });

    it(`is nothing without a target`, () => {
        expect(windowGesture(pressOn(null, 4), layoutOf())).toBeUndefined();
        expect(windowGesture(pressOn(document, 4), layoutOf())).toBeUndefined();
    });
});

describe(`pressOf`, () => {
    it(`reads the press off the mouse event, clicks and modifiers included`, () => {
        const air = mount(`<div id="air"></div>`).querySelector(`#air`) as HTMLElement;
        let press: Press | undefined;
        air.addEventListener(`mousedown`, (event) => {
            press = pressOf(event);
        });

        air.dispatchEvent(new MouseEvent(`mousedown`, { clientX: 40, clientY: 12, detail: 2, shiftKey: true, bubbles: true }));

        expect(press).toEqual({ target: air, x: 40, y: 12, clicks: 2, modified: true });
    });
});
