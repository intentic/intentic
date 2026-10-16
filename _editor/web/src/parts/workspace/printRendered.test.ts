// What goes to paper: the surface's own markup, with nothing left in it that could run or reach outside the app.
import "@intentic/testing/dom";
import { printableDocument } from "./printRendered";

const parse = (html: string): Document => new DOMParser().parseFromString(html, `text/html`);

describe(`printableDocument`, () => {
    it(`keeps what the page shows and drops scripts, handlers, frames and script links`, () => {
        const printed = parse(
            printableDocument(`<html><head><script>alert(1)</script><base href="https://elsewhere.test/"><meta http-equiv="refresh" content="0;url=https://elsewhere.test"></head>
                <body><h1 onclick="steal()">Pismo</h1><a href="javascript:steal()">link</a><img src="data:image/png;base64,AA" onerror="steal()">
                <iframe src="https://elsewhere.test"></iframe><object data="x.pdf"></object><button>Zamknij</button><p>Treść</p></body></html>`),
        );
        expect(printed.querySelector(`h1`)?.textContent).toBe(`Pismo`);
        expect(printed.querySelector(`p`)?.textContent).toBe(`Treść`);
        expect(printed.querySelectorAll(`script, iframe, object, button, base, meta[http-equiv="refresh"]`)).toHaveLength(0);
        expect(printed.querySelector(`h1`)?.hasAttribute(`onclick`)).toBe(false);
        expect(printed.querySelector(`img`)?.hasAttribute(`onerror`)).toBe(false);
        expect(printed.querySelector(`a`)?.hasAttribute(`href`)).toBe(false);
    });

    it(`opens its head with a policy that loads nothing from outside the app and runs no script`, () => {
        const first = parse(printableDocument(`<p>x</p>`)).head.firstElementChild;
        expect(first?.getAttribute(`http-equiv`)).toBe(`Content-Security-Policy`);
        expect(first?.getAttribute(`content`)).toContain(`default-src 'none'`);
        expect(first?.getAttribute(`content`)).not.toContain(`script-src`);
    });

    it(`prints a document's pages edge to edge, one per sheet, and anything else with a margin`, () => {
        expect(printableDocument(`<div class="docx-wrapper"><section class="docx"></section></div>`)).toContain(`@page{margin:0}`);
        expect(printableDocument(`<article>notes</article>`)).toContain(`@page{margin:15mm}`);
    });
});
