import { describe, expect, it } from "vitest";
import { parseRtf } from "./parse";
import { textOfBlock, type Block } from "../odf/model";

/* What an .rtf says, and how it wanted to say it. */

const EMPTY: Block = { kind: `paragraph`, level: 0, css: {}, inlines: [] };

const rtf = (body: string, images: (bytes: Uint8Array, type: string) => string | undefined = (bytes, type) => `blob:${type}/${bytes.length}`) =>
    parseRtf(new TextEncoder().encode(`{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0\\froman Times New Roman;}{\\f1\\fswiss Arial;}}${body}}`), images);

const texts = (parsed: ReturnType<typeof parseRtf>): string[] => parsed.blocks.map((block) => textOfBlock(block));

describe(`parseRtf`, () => {
    it(`reads paragraphs`, () => {
        expect(texts(rtf(`\\pard First paragraph.\\par Second paragraph.\\par`))).toEqual([`First paragraph.`, `Second paragraph.`]);
    });

    it(`carries bold, italic, underline and size as CSS`, () => {
        const parsed = rtf(`\\pard\\fs28 {\\b bold}{\\i italic}{\\ul under}\\par`);
        const block = parsed.blocks[0];
        const css = block?.kind === `paragraph` ? block.inlines.map((inline) => (inline.kind === `text` ? inline.css : {})) : [];
        expect(css[0]).toMatchObject({ "font-weight": `bold`, "font-size": `14pt` });
        expect(css[1]).toMatchObject({ "font-style": `italic` });
        expect(css[2]).toMatchObject({ "text-decoration-line": `underline` });
    });

    it(`restores the formatting a group changed when the group ends`, () => {
        const parsed = rtf(`\\pard {\\b bold}plain\\par`);
        const block = parsed.blocks[0];
        const plain = block?.kind === `paragraph` ? block.inlines[1] : undefined;
        expect(plain?.kind === `text` ? plain.css : {}).toEqual({});
    });

    it(`names the font the file's table names, not its number`, () => {
        const parsed = rtf(`\\pard\\f1 Arial text\\par`);
        const block = parsed.blocks[0];
        const run = block?.kind === `paragraph` ? block.inlines[0] : undefined;
        expect(run?.kind === `text` ? run.css[`font-family`] : undefined).toBe(`Arial`);
    });

    it(`reads a colour out of the colour table, counting from one`, () => {
        const parsed = rtf(`{\\colortbl;\\red255\\green0\\blue0;}\\pard\\cf1 red\\par`);
        const block = parsed.blocks[0];
        const run = block?.kind === `paragraph` ? block.inlines[0] : undefined;
        expect(run?.kind === `text` ? run.css[`color`] : undefined).toBe(`rgb(255 0 0)`);
    });

    it(`decodes a byte through the document's code page, and a \\u escape without its fallback`, () => {
        // \'e9 is é in windows-1252; \u233 says the same thing and is followed by one fallback character to drop.
        expect(texts(rtf(`\\pard caf\\'e9 and \\u233?\\par`))).toEqual([`café and é`]);
    });

    it(`skips a group marked ignorable, whose contents are not the document's text`, () => {
        // An embedded font's hex payload would otherwise read as text, and its name would be that payload.
        expect(texts(rtf(`\\pard{\\*\\fontemb{\\*\\fontfile deadbeef}}Visible\\par`))).toEqual([`Visible`]);
    });

    it(`turns a HYPERLINK field into a link on the text the field produced`, () => {
        const parsed = rtf(`\\pard{\\field{\\*\\fldinst {HYPERLINK "https://example.com/a" }}{\\fldrslt {the page}}}\\par`);
        const block = parsed.blocks[0];
        const link = block?.kind === `paragraph` ? block.inlines.find((inline) => inline.kind === `link`) : undefined;
        expect(link).toMatchObject({ kind: `link`, href: `https://example.com/a` });
        expect(textOfBlock(block ?? EMPTY)).toBe(`the page`);
    });

    it(`reads a table's rows, cells and column widths`, () => {
        const row = (first: string, second: string): string =>
            `\\trowd\\cellx1440\\cellx4320 ${first}\\cell ${second}\\cell\\row`;
        const parsed = rtf(`\\pard${row(`Item`, `Count`)}${row(`Pens`, `3`)}\\pard After\\par`);
        const table = parsed.blocks[0];
        expect(table?.kind).toBe(`table`);
        if (table?.kind !== `table`) {
            return;
        }
        expect(table.columns).toEqual([`1.000in`, `2.000in`]);
        expect(table.rows).toHaveLength(2);
        expect(table.rows[1]?.cells.map((cell) => cell.blocks.map((block) => textOfBlock(block)).join(``))).toEqual([`Pens`, `3`]);
        expect(texts(parsed).at(-1)).toBe(`After`);
    });

    it(`clears character formatting on \\plain, so a header's white text does not run into the cells after it`, () => {
        // \pard resets the PARAGRAPH; \plain resets the characters. Read as the same thing, a white-on-green header
        // leaves every following cell white on white — text that is there and cannot be seen.
        const parsed = rtf(`{\\colortbl;\\red255\\green255\\blue255;}\\pard\\cf1\\b Header\\par\\pard\\plain Body\\par`);
        const body = parsed.blocks[1];
        const run = body?.kind === `paragraph` ? body.inlines[0] : undefined;
        expect(run?.kind === `text` ? run.css : {}).toEqual({});
    });

    it(`paints a cell the shading its column declares`, () => {
        const parsed = rtf(`{\\colortbl;\\red155\\green187\\blue89;}\\pard\\trowd\\clcbpat1\\cellx1440\\cellx2880 head\\cell plain\\cell\\row`);
        const table = parsed.blocks[0];
        const cells = table?.kind === `table` ? table.rows[0]?.cells : undefined;
        expect(cells?.[0]?.css).toEqual({ "background-color": `rgb(155 187 89)` });
        expect(cells?.[1]?.css).toEqual({});
    });

    it(`writes the characters RTF spells as control words`, () => {
        // An em dash is how a table says "no value"; dropped, the cell reads as empty.
        expect(texts(rtf(`\\pard 87\\emdash 91 \\ldblquote quoted\\rdblquote \\bullet\\par`))).toEqual([`87—91 “quoted”•`]);
    });

    it(`starts a new table where the columns change, rather than one ragged grid`, () => {
        const parsed = rtf(`\\pard\\trowd\\cellx1440 a\\cell\\row\\trowd\\cellx720\\cellx1440 b\\cell c\\cell\\row`);
        const tables = parsed.blocks.filter((block) => block.kind === `table`);
        expect(tables).toHaveLength(2);
        expect(tables[0]?.kind === `table` ? tables[0].rows[0]?.cells.length : 0).toBe(1);
        expect(tables[1]?.kind === `table` ? tables[1].rows[0]?.cells.length : 0).toBe(2);
    });

    it(`decodes a picture and asks for a URL for it`, () => {
        const seen: string[] = [];
        // 89504e47 is a PNG's first four bytes; \pngblip says which format the hex is in.
        const parsed = rtf(`\\pard{\\pict\\pngblip\\picwgoal1440\\pichgoal720 89504e47}\\par`, (bytes, type) => {
            seen.push(`${type}:${[...bytes].map((byte) => byte.toString(16)).join(``)}`);
            return `blob:picture`;
        });
        expect(seen).toEqual([`image/png:89504e47`]);
        const block = parsed.blocks[0];
        const image = block?.kind === `paragraph` ? block.inlines[0] : undefined;
        expect(image).toMatchObject({ kind: `image`, src: `blob:picture`, css: { width: `1.000in`, height: `0.500in` } });
    });

    it(`leaves out hidden text and the file's own bookkeeping`, () => {
        expect(texts(rtf(`{\\info{\\title Secret}}\\pard Shown {\\v hidden}\\par`))).toEqual([`Shown `]);
    });

    it(`takes the page size and margins from the document, falling back to Letter`, () => {
        expect(rtf(`\\paperw11906\\margl1134\\pard Text\\par`).geometry).toMatchObject({ width: `8.268in`, padding: { "padding-left": `0.787in` } });
        expect(rtf(`\\pard Text\\par`).geometry.width).toBe(`8.500in`);
    });

    it(`says a document with nothing in it is empty`, () => {
        expect(rtf(``).empty).toBe(true);
    });
});
