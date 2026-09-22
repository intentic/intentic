import { describe, it, expect } from "bun:test";
import { stubGlobal } from "@intentic/testing/bun";
import { textOfBlock } from "./document-model";
import { openOdf } from "./pkg";
import { readPresentation } from "./slides";
import { contentXml, odfBytes, PNG_PIXEL, SLIDES_MIME, stylesXml } from "./testing";

/* A slide is a page of boxes at fixed positions; what matters is that each box keeps its place, its fill and its
   text. */

stubGlobal(`URL`, { ...URL, createObjectURL: (blob: Blob) => `blob:test/${blob.size}`, revokeObjectURL: () => {} });

const GRAPHICS = `<style:style style:name="gr1" style:family="graphic"><style:graphic-properties draw:fill="solid" draw:fill-color="#204060" draw:stroke="none" draw:textarea-vertical-align="middle"/></style:style>`;

const SLIDE_STYLES = stylesXml(
    `<style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties draw:fill="solid" draw:fill-color="#fafafa"/></style:style>`,
    `draw:style-name="dp1"`,
);

const deckOf = (pages: string, automatic = GRAPHICS, files?: Parameters<typeof odfBytes>[0][`files`]) =>
    readPresentation(
        openOdf(
            odfBytes({
                mimetype: SLIDES_MIME,
                content: contentXml(`<office:presentation>${pages}</office:presentation>`, automatic),
                styles: SLIDE_STYLES,
                files,
            }),
        ),
    );

describe(`readPresentation`, () => {
    it(`reads each slide, its name and the deck's size`, () => {
        const deck = deckOf(`<draw:page draw:name="Title"/><draw:page draw:name="Agenda"/>`);
        expect(deck.slides.map((slide) => slide.name)).toEqual([`Title`, `Agenda`]);
        // The master page's layout, in centimetres, which is what the viewer scales from.
        expect(deck.width).toBeCloseTo(21, 5);
        expect(deck.height).toBeCloseTo(29.7, 5);
    });

    it(`puts a text box where the file puts it, with its fill and its text`, () => {
        const deck = deckOf(
            `<draw:page draw:name="One"><draw:frame draw:style-name="gr1" svg:x="2cm" svg:y="3cm" svg:width="10cm" svg:height="4cm">` +
                `<draw:text-box><text:p>Hello</text:p></draw:text-box></draw:frame></draw:page>`,
        );
        const shape = deck.slides[0]?.shapes[0];
        expect(shape?.css).toMatchObject({
            position: `absolute`,
            left: `2cm`,
            top: `3cm`,
            width: `10cm`,
            height: `4cm`,
            "background-color": `#204060`,
        });
        expect(shape?.css[`--odf-anchor`]).toBe(`center`);
        expect(textOfBlock(shape?.blocks[0] ?? { kind: `paragraph`, level: 0, css: {}, inlines: [] })).toBe(`Hello`);
    });

    it(`flattens a group, whose children carry their own positions`, () => {
        const deck = deckOf(
            `<draw:page draw:name="One"><draw:g><draw:rect svg:x="1cm" svg:y="1cm"/><draw:ellipse svg:x="4cm" svg:y="1cm"/></draw:g></draw:page>`,
        );
        expect(deck.slides[0]?.shapes).toHaveLength(2);
        expect(deck.slides[0]?.shapes[1]?.css[`border-radius`]).toBe(`50%`);
    });

    it(`shows a picture, and prefers live content to the picture a writer leaves beside it`, () => {
        const files = { "Pictures/one.png": { bytes: PNG_PIXEL, type: `image/png` } };
        const page =
            `<draw:page draw:name="One">` +
            `<draw:frame svg:x="1cm" svg:y="1cm"><draw:image xlink:href="Pictures/one.png"/></draw:frame>` +
            `<draw:frame svg:x="1cm" svg:y="8cm"><table:table><table:table-row><table:table-cell><text:p>Live</text:p></table:table-cell></table:table-row></table:table>` +
            `<draw:image xlink:href="Pictures/one.png"/></draw:frame></draw:page>`;
        const [picture, table] = deckOf(page, GRAPHICS, files).slides[0]?.shapes ?? [];
        expect(picture?.image?.src.startsWith(`blob:`)).toBe(true);
        expect(table?.image).toBeUndefined();
        expect(table?.blocks[0]?.kind).toBe(`table`);
    });

    it(`carries the presenter's notes, which are not on the slide`, () => {
        const deck = deckOf(
            `<draw:page draw:name="One"><presentation:notes><draw:frame><draw:text-box><text:p>Say this out loud.</text:p></draw:text-box></draw:frame></presentation:notes></draw:page>`,
        );
        expect(deck.slides[0]?.notes.map((block) => textOfBlock(block))).toEqual([`Say this out loud.`]);
        // The notes page is not a shape on the slide.
        expect(deck.slides[0]?.shapes).toHaveLength(0);
    });

    it(`leaves a slide-number placeholder out of the notes, which are what the speaker says`, () => {
        const deck = deckOf(
            `<draw:page draw:name="One"><presentation:notes>` +
                `<draw:frame><draw:text-box><text:p>7</text:p></draw:text-box></draw:frame>` +
                `<draw:frame><draw:text-box><text:p>The real note.</text:p></draw:text-box></draw:frame>` +
                `</presentation:notes></draw:page>`,
        );
        expect(deck.slides[0]?.notes.map((block) => textOfBlock(block))).toEqual([`The real note.`]);
    });

    it(`paints the background the master page sets`, () => {
        expect(deckOf(`<draw:page draw:name="One" draw:master-page-name="Standard"/>`).slides[0]?.background).toBe(`#fafafa`);
    });

    it(`reads a drawing the same way it reads a presentation`, () => {
        const drawing = odfBytes({
            mimetype: `application/vnd.oasis.opendocument.graphics`,
            content: contentXml(`<office:drawing><draw:page draw:name="Page 1"><draw:rect svg:x="1cm" svg:y="1cm"/></draw:page></office:drawing>`),
            styles: SLIDE_STYLES,
        });
        expect(readPresentation(openOdf(drawing)).slides[0]?.shapes).toHaveLength(1);
    });
});
