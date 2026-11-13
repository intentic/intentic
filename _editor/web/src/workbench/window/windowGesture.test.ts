import "@intentic/testing/dom";
import { domLayout, type Layout, type Press, pressOf, windowGesture } from "./windowGesture";

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
    nearText: () => false,
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

        expect(windowGesture(pressOn(label, 12), layoutOf({ nearText: () => true }))).toBe(`drag`);
    });

    it(`is exactly as tall as the window's own buttons`, () => {
        const text = mount(`<p id="text">a line</p>`).querySelector(`#text`);
        const onText = layoutOf({ nearText: () => true });

        expect(windowGesture(pressOn(text, BAND), onText)).toBe(`drag`);
        expect(windowGesture(pressOn(text, BAND + 1), onText)).toBeUndefined();
    });
});

describe(`the background`, () => {
    it(`drags the window from an empty stretch below the band`, () => {
        const canvas = mount(`<main><section id="canvas"><p>Ask anything.</p></section></main>`).querySelector(`#canvas`);

        expect(windowGesture(pressOn(canvas, 400), layoutOf())).toBe(`drag`);
    });

    /* A selection is started from beside the words as often as from on them: the gap above a paragraph, a bubble's padding. */
    it(`leaves text, and the margin around it, to the selection the press would start`, () => {
        const prose = mount(`<article id="prose"><p>a paragraph</p></article>`).querySelector(`#prose`);
        const asked: [EventTarget | null, number, number][] = [];
        const nearText = (target: Element, x: number, y: number): boolean => {
            asked.push([target, x, y]);
            return true;
        };

        expect(windowGesture(pressOn(prose, 400), layoutOf({ nearText }))).toBeUndefined();
        expect(asked, `asked about the press itself`).toEqual([[prose, 100, 400]]);
    });

    it(`drags from text nobody can select`, () => {
        const badge = mount(`<div id="badge" class="select-none">ACTIVE</div>`).querySelector(`#badge`);
        const unselectable = layoutOf({
            styleOf: () => ({ cursor: `auto`, userSelect: `none`, position: `static` }),
            nearText: () => true,
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

/* HOW NEAR TEXT A PRESS IS, as the document lays it out. jsdom lays nothing out, so each element says where it sits
   (`data-box="left,top,width,height"`) and a text's glyphs come from its holder's `data-glyphs` in the same order.
   The caret hit test answers with the text whose holder is nearest the point, the way a browser resolves a press on
   the background to the nearest caret. Every line here is 16px of glyphs in a 20px line: a reach of 20px above and
   below, 40px to either side. */
describe(`near text, as the document lays it out`, () => {
    const numbers = (raw: string | null): number[] => (raw ?? ``).split(`,`).filter(Boolean).map(Number);
    const rectOf = (raw: string | null): DOMRect => {
        const [left = 0, top = 0, width = 0, height = 0] = numbers(raw);
        return new DOMRect(left, top, width, height);
    };
    const distance = (box: DOMRect, x: number, y: number): number =>
        Math.hypot(Math.max(box.left - x, 0, x - box.right), Math.max(box.top - y, 0, y - box.bottom));

    const caretAt = (x: number, y: number): { offsetNode: Node; offset: number } | null => {
        let nearest: { node: Text; distance: number } | undefined;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const holder = node.parentElement;
            if (!(node instanceof Text) || holder === null || !holder.hasAttribute(`data-glyphs`)) {
                continue;
            }
            const away = distance(holder.getBoundingClientRect(), x, y);
            if (nearest === undefined || away < nearest.distance) {
                nearest = { node, distance: away };
            }
        }
        return nearest === undefined ? null : { offsetNode: nearest.node, offset: 0 };
    };

    const original = { box: Element.prototype.getBoundingClientRect, lines: Range.prototype.getClientRects };
    beforeAll(() => {
        Element.prototype.getBoundingClientRect = function box(this: Element): DOMRect {
            return rectOf(this.getAttribute(`data-box`));
        };
        Range.prototype.getClientRects = function lines(this: Range): DOMRectList {
            const rects = [rectOf(this.startContainer.parentElement?.getAttribute(`data-glyphs`) ?? null)];
            return Object.assign(rects, { item: (index: number) => rects[index] ?? null });
        };
        Object.defineProperty(document, `caretPositionFromPoint`, { configurable: true, value: caretAt });
    });
    afterAll(() => {
        Element.prototype.getBoundingClientRect = original.box;
        Range.prototype.getClientRects = original.lines;
        Reflect.deleteProperty(document, `caretPositionFromPoint`);
    });

    const element = (selector: string): HTMLElement => {
        const found = document.querySelector<HTMLElement>(selector);
        if (found === null) {
            throw new Error(`${selector} is not in the fixture`);
        }
        return found;
    };
    const near = (target: string, x: number, y: number): boolean => domLayout(BAND).nearText(element(target), x, y);

    // A column 400 wide at x 300: a paragraph, a short line 20px under it, and a third after a gap of 64px.
    const COLUMN = `
        <main id="column" data-box="0,0,1024,768" style="line-height: 20px">
            <p data-box="300,100,400,20" data-glyphs="300,102,380,16">a first paragraph that runs the column's width</p>
            <p data-box="300,140,400,20" data-glyphs="300,142,120,16">a short line</p>
            <p data-box="300,224,400,20" data-glyphs="300,226,380,16">the next message, after a wider gap</p>
        </main>`;

    it(`counts the gap between two paragraphs as the text's`, () => {
        mount(COLUMN);

        expect(near(`#column`, 500, 130)).toBe(true);
    });

    it(`runs a line as wide as its block, so the empty end of a short line is still on it`, () => {
        mount(COLUMN);

        expect(near(`#column`, 650, 150)).toBe(true);
    });

    /* Twice a line's height to either side: the margin beside a column is where a selection of whole lines starts. */
    it(`reaches into the margin beside a column, and no farther`, () => {
        mount(COLUMN);

        expect(near(`#column`, 270, 110), `30px left of the column`).toBe(true);
        expect(near(`#column`, 240, 110), `60px left of it`).toBe(false);
    });

    /* Out of both lines' reach, but with text close above and below it: inside the run of the text, not a stripe of handle in it. */
    it(`bridges a gap wider than a reach when text is close on both sides`, () => {
        mount(COLUMN);

        expect(near(`#column`, 500, 192)).toBe(true);
    });

    it(`leaves the background past the last line's reach to the window`, () => {
        mount(COLUMN);

        expect(near(`#column`, 500, 260), `16px under the last line`).toBe(true);
        expect(near(`#column`, 500, 400), `well below it`).toBe(false);
    });

    /* A toolbar or a list stays a handle however many labels it holds; a link reads as prose. */
    it(`passes over a control's label, and not over a link`, () => {
        mount(`
            <div id="bar" data-box="0,300,1024,40" style="line-height: 20px">
                <button data-box="300,308,80,24" data-glyphs="310,312,60,16">Open</button>
            </div>
            <p id="prose" data-box="300,500,400,20" style="line-height: 20px"><a href="/x" data-box="300,500,60,20" data-glyphs="300,502,60,16">docs</a></p>`);

        expect(near(`#bar`, 420, 320), `beside the button`).toBe(false);
        expect(near(`#prose`, 380, 510), `beside the link`).toBe(true);
    });

    it(`passes over text nobody can select`, () => {
        mount(`
            <main id="column" data-box="0,0,1024,768" style="line-height: 20px">
                <p data-box="300,100,400,20" data-glyphs="300,102,380,16" style="user-select: none">ACTIVE</p>
            </main>`);

        expect(near(`#column`, 500, 130)).toBe(false);
    });

    /* A label alone in a flex row is an anonymous item as wide as its words; the rest of the row is background. */
    it(`runs the words of a flex row's own text only as wide as they are`, () => {
        mount(`<div id="row" data-box="0,300,1024,40" data-glyphs="300,312,60,16" style="display: flex; line-height: 20px">Agents</div>`);

        expect(near(`#row`, 380, 320), `20px past the label`).toBe(true);
        expect(near(`#row`, 600, 320), `across the row`).toBe(false);
    });

    /* The words in the title band are a title's: a press just under the band is not next to them. */
    it(`passes over the words in the title band`, () => {
        mount(`
            <main id="column" data-box="0,0,1024,768" style="line-height: 20px">
                <p data-box="300,8,400,20" data-glyphs="300,10,100,16">Agents</p>
            </main>`);

        expect(near(`#column`, 500, 44)).toBe(false);
    });

    /* The header over a scrolled transcript is not next to the line just under it, though nothing else lies between. */
    describe(`a scroller`, () => {
        const SCROLLED = `
            <header id="header" data-box="0,40,1024,40"></header>
            <div id="scroller" data-box="0,80,1024,400" style="overflow-y: auto; line-height: 20px">
                <p data-box="300,50,400,20" data-glyphs="300,52,380,16">a line scrolled up out of sight</p>
                <p data-box="300,82,400,20" data-glyphs="300,84,380,16">the first line on show</p>
            </div>`;

        const scrolling = (height: number): void => {
            const scroller = element(`#scroller`);
            Object.defineProperty(scroller, `clientHeight`, { configurable: true, value: 400 });
            Object.defineProperty(scroller, `scrollHeight`, { configurable: true, value: height });
        };

        it(`hides what it holds from a press outside it, along the axis it scrolls on`, () => {
            mount(SCROLLED);
            scrolling(2000);

            expect(near(`#header`, 500, 76)).toBe(false);
        });

        it(`is no edge while it has nothing to scroll`, () => {
            mount(SCROLLED);
            scrolling(400);

            expect(near(`#header`, 500, 76)).toBe(true);
        });

        it(`shows no line it has scrolled out of sight`, () => {
            mount(SCROLLED.replace(`data-glyphs="300,84,380,16"`, `data-glyphs="300,600,380,16"`));
            scrolling(2000);

            expect(near(`#scroller`, 500, 82), `just under the line scrolled away above the edge`).toBe(false);
        });
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
