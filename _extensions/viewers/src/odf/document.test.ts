import { describe, it, expect } from "bun:test";
import { stubGlobal } from "@intentic/testing/bun";
import { readTextDocument } from "./document";
import { textOfBlock } from "./document-model";
import { openOdf } from "./pkg";
import { contentXml, odfBytes, PNG_PIXEL, stylesXml, TEXT_MIME } from "./testing";

/* What a reader sees of an .odt: its text, the formatting the file asked for, and its pictures. */

stubGlobal(`URL`, { ...URL, createObjectURL: (blob: Blob) => `blob:test/${blob.size}`, revokeObjectURL: () => {} });

const AUTOMATIC = [
    `<style:style style:name="T1" style:family="text"><style:text-properties fo:font-weight="bold" fo:color="#cc0000" style:text-underline-style="solid"/></style:style>`,
    `<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center" fo:margin-bottom="0.5cm"/></style:style>`,
    `<style:style style:name="P2" style:family="paragraph" style:parent-style-name="P1"><style:text-properties fo:font-size="18pt"/></style:style>`,
    `<style:style style:name="co1" style:family="table-column"><style:table-column-properties style:column-width="4cm"/></style:style>`,
].join(``);

const documentOf = (body: string, automatic = AUTOMATIC, styles?: string) =>
    readTextDocument(
        openOdf(odfBytes({ mimetype: TEXT_MIME, content: contentXml(`<office:text>${body}</office:text>`, automatic), styles, title: `Report` })),
    );

describe(`readTextDocument`, () => {
    it(`reads headings, paragraphs and the document's title`, () => {
        const doc = documentOf(`<text:h text:outline-level="2">Findings</text:h><text:p>Plain text.</text:p>`);
        expect(doc.title).toBe(`Report`);
        expect(doc.pages).toHaveLength(1);
        const [heading, paragraph] = doc.pages[0] ?? [];
        expect(heading).toMatchObject({ kind: `paragraph`, level: 2 });
        expect(textOfBlock(heading ?? { kind: `paragraph`, level: 0, css: {}, inlines: [] })).toBe(`Findings`);
        expect(paragraph).toMatchObject({ kind: `paragraph`, level: 0 });
    });

    it(`carries the file's own formatting through as CSS`, () => {
        const doc = documentOf(`<text:p text:style-name="P1">Before <text:span text:style-name="T1">important</text:span> after.</text:p>`);
        const block = doc.pages[0]?.[0];
        expect(block?.kind === `paragraph` ? block.css : {}).toMatchObject({ "text-align": `center`, "margin-bottom": `0.5cm` });
        const span = block?.kind === `paragraph` ? block.inlines[1] : undefined;
        expect(span).toMatchObject({
            kind: `text`,
            text: `important`,
            css: { "font-weight": `bold`, color: `#cc0000`, "text-decoration-line": `underline` },
        });
    });

    it(`inherits from a parent style`, () => {
        const doc = documentOf(`<text:p text:style-name="P2">Inherited.</text:p>`);
        const block = doc.pages[0]?.[0];
        expect(block?.kind === `paragraph` ? block.css[`text-align`] : undefined).toBe(`center`);
        const run = block?.kind === `paragraph` ? block.inlines[0] : undefined;
        expect(run?.kind === `text` ? run.css[`font-size`] : undefined).toBe(`18pt`);
    });

    it(`keeps the spaces ODF spells out, which HTML would otherwise collapse`, () => {
        const doc = documentOf(`<text:p>a<text:s text:c="3"/>b</text:p>`);
        const block = doc.pages[0]?.[0];
        expect(textOfBlock(block ?? { kind: `paragraph`, level: 0, css: {}, inlines: [] })).toBe(`a   b`);
    });

    it(`reads a table with its column widths and spans`, () => {
        const doc = documentOf(
            `<table:table><table:table-column table:style-name="co1" table:number-columns-repeated="2"/>` +
                `<table:table-header-rows><table:table-row><table:table-cell><text:p>Item</text:p></table:table-cell><table:table-cell><text:p>Count</text:p></table:table-cell></table:table-row></table:table-header-rows>` +
                `<table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>Total</text:p></table:table-cell><table:covered-table-cell/></table:table-row>` +
                `</table:table>`,
        );
        const table = doc.pages[0]?.[0];
        expect(table?.kind).toBe(`table`);
        if (table?.kind !== `table`) {
            return;
        }
        expect(table.columns).toEqual([`4cm`, `4cm`]);
        expect(table.rows[0]?.header).toBe(true);
        expect(table.rows[1]?.cells).toHaveLength(1);
        expect(table.rows[1]?.cells[0]?.colspan).toBe(2);
    });

    it(`numbers and bullets a list the way its style says`, () => {
        const styles = stylesXml(
            `<text:list-style style:name="L1"><text:list-level-style-number text:level="1" style:num-format="i" text:start-value="3"/></text:list-style>`,
        );
        const doc = documentOf(
            `<text:list text:style-name="L1"><text:list-item><text:p>One</text:p></text:list-item></text:list>`,
            AUTOMATIC,
            styles,
        );
        expect(doc.pages[0]?.[0]).toMatchObject({ kind: `list`, ordered: true, type: `lower-roman`, start: 3 });
    });

    it(`gives a list with no number format no marker at all`, () => {
        // A converter writes `style:num-format=""` for a plain paragraph that happens to live in a list. Read as a
        // missing format, every such line is numbered "1." — and a converted deck is full of them.
        const styles = stylesXml(
            `<text:list-style style:name="L0"><text:list-level-style-number text:level="1" style:num-format=""/></text:list-style>` +
                `<text:list-style style:name="L2"><text:list-level-style-bullet text:level="1" text:bullet-char=""/></text:list-style>`,
        );
        const unnumbered = documentOf(
            `<text:list text:style-name="L0"><text:list-item><text:p>Line</text:p></text:list-item></text:list>`,
            AUTOMATIC,
            styles,
        );
        expect(unnumbered.pages[0]?.[0]).toMatchObject({ kind: `list`, type: `none` });
        const unbulleted = documentOf(
            `<text:list text:style-name="L2"><text:list-item><text:p>Line</text:p></text:list-item></text:list>`,
            AUTOMATIC,
            styles,
        );
        expect(unbulleted.pages[0]?.[0]).toMatchObject({ kind: `list`, type: `none` });
    });

    it(`shows a picture the package carries, and nothing a document points at elsewhere`, () => {
        const files = { "Pictures/one.png": { bytes: PNG_PIXEL, type: `image/png` } };
        const body =
            `<text:p><draw:frame svg:width="3cm" svg:height="2cm"><draw:image xlink:href="Pictures/one.png"/><svg:title>A chart</svg:title></draw:frame></text:p>` +
            `<text:p><draw:frame><draw:image xlink:href="https://example.com/tracker.png"/></draw:frame></text:p>`;
        const doc = readTextDocument(openOdf(odfBytes({ mimetype: TEXT_MIME, content: contentXml(`<office:text>${body}</office:text>`), files })));
        const [first, second] = doc.pages[0] ?? [];
        const image = first?.kind === `paragraph` ? first.inlines[0] : undefined;
        expect(image).toMatchObject({ kind: `image`, alt: `A chart`, css: { width: `3cm`, height: `2cm` } });
        expect(image?.kind === `image` ? image.src.startsWith(`blob:`) : false).toBe(true);
        // A remote picture is never fetched: loading it would tell its host that this file was opened.
        expect(second?.kind === `paragraph` ? second.inlines : []).toEqual([]);
    });

    it(`splits pages where the file says a printed copy would break`, () => {
        const automatic = `${AUTOMATIC}<style:style style:name="P9" style:family="paragraph"><style:paragraph-properties fo:break-before="page"/></style:style>`;
        const doc = documentOf(
            `<text:p>One</text:p><text:soft-page-break/><text:p>Two</text:p><text:p text:style-name="P9">Three</text:p>`,
            automatic,
        );
        expect(doc.pages.map((page) => page.map((block) => textOfBlock(block)))).toEqual([[`One`], [`Two`], [`Three`]]);
    });

    it(`leaves out comments and tracked changes, which are not what the page says`, () => {
        const doc = documentOf(`<text:p>Kept<office:annotation><text:p>Reviewer note</text:p></office:annotation></text:p>`);
        expect(textOfBlock(doc.pages[0]?.[0] ?? { kind: `paragraph`, level: 0, css: {}, inlines: [] })).toBe(`Kept`);
    });

    it(`puts a footnote's text after the page that cites it`, () => {
        const doc = documentOf(
            `<text:p>Claim<text:note text:note-class="footnote"><text:note-citation>1</text:note-citation><text:note-body><text:p>The source.</text:p></text:note-body></text:note></text:p>`,
        );
        const blocks = doc.pages[0] ?? [];
        expect(textOfBlock(blocks[0] ?? { kind: `paragraph`, level: 0, css: {}, inlines: [] })).toBe(`Claim1`);
        expect(textOfBlock(blocks[1] ?? { kind: `paragraph`, level: 0, css: {}, inlines: [] })).toBe(`1 The source.`);
    });

    it(`says a document is empty rather than drawing a blank page`, () => {
        expect(documentOf(``).empty).toBe(true);
        expect(documentOf(`<text:p>Something</text:p>`).empty).toBe(false);
    });

    it(`takes the page's size and margins from the master page`, () => {
        expect(documentOf(`<text:p>Text</text:p>`).geometry).toMatchObject({
            width: `21cm`,
            height: `29.7cm`,
            margin: { "padding-left": `2cm`, "padding-top": `2cm` },
        });
    });
});
