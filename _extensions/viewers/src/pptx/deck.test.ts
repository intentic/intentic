// @vitest-environment jsdom
// The parse is what decides whether a slide is readable: everything a shape does not say for itself is said by its
// layout, its master or the theme, and every one of those walks is asserted here against real OOXML rather than a
// convenient shape of it. Fixtures are built part by part, because "what a .pptx actually contains" is the thing
// under test.
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { readDeck } from "./deck";
import type { ImageBox, TableBox, TextBox, UnsupportedBox } from "./deck-model";

const NS = `xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`;
const REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

const rels = (entries: readonly (readonly [string, string, string])[]): string =>
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries
        .map(([id, kind, target]) => `<Relationship Id="${id}" Type="${REL_TYPE}/${kind}" Target="${target}"/>`)
        .join("")}</Relationships>`;

// A placeholder shape: the `<p:nvSpPr>` wrapper is what marks a shape as one, and it is the whole reason inheritance
// has anything to hang off.
const shape = (options: { ph?: string; idx?: string; xfrm?: string; body?: string; spPr?: string; name?: string }): string => `
    <p:sp>
        <p:nvSpPr>
            <p:cNvPr id="2" name="${options.name ?? "Shape"}"/>
            <p:cNvSpPr/>
            <p:nvPr>${options.ph === undefined ? "" : `<p:ph type="${options.ph}"${options.idx === undefined ? "" : ` idx="${options.idx}"`}/>`}</p:nvPr>
        </p:nvSpPr>
        <p:spPr>${options.xfrm ?? ""}${options.spPr ?? ""}</p:spPr>
        <p:txBody><a:bodyPr/>${options.body ?? ""}</p:txBody>
    </p:sp>`;

const xfrm = (x: number, y: number, cx: number, cy: number): string =>
    `<a:xfrm><a:off x="${x}" y="${y}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`;

const slide = (body: string): string => `<p:sld ${NS}><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;

// A theme with one dark and one light slot plus an accent, which is the minimum a deck's colours resolve through.
const THEME = `<a:theme ${NS}><a:themeElements>
    <a:clrScheme name="test">
        <a:dk1><a:sysClr val="windowText" lastClr="1F1F1F"/></a:dk1>
        <a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
        <a:dk2><a:srgbClr val="44546A"/></a:dk2>
        <a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>
        <a:accent1><a:srgbClr val="4472C4"/></a:accent1>
    </a:clrScheme>
    <a:fontScheme name="test">
        <a:majorFont><a:latin typeface="Georgia"/></a:majorFont>
        <a:minorFont><a:latin typeface="Verdana"/></a:minorFont>
    </a:fontScheme>
</a:themeElements></a:theme>`;

// The master carries the colour map and the per-kind text styles: a title is 44pt here and nowhere else.
const MASTER = `<p:sldMaster ${NS}>
    <p:cSld><p:bg><p:bgPr><a:solidFill><a:schemeClr val="bg1"/></a:solidFill></p:bgPr></p:bg><p:spTree/></p:cSld>
    <p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1"/>
    <p:txStyles>
        <p:titleStyle><a:lvl1pPr algn="ctr"><a:defRPr sz="4400" b="1"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle>
        <p:bodyStyle>
            <a:lvl1pPr marL="342900"><a:buChar char="•"/><a:defRPr sz="2800"><a:solidFill><a:schemeClr val="tx1"><a:lumMod val="65000"/><a:lumOff val="35000"/></a:schemeClr></a:solidFill></a:defRPr></a:lvl1pPr>
            <a:lvl2pPr marL="742950"><a:buChar char="–"/><a:defRPr sz="2400"/></a:lvl2pPr>
        </p:bodyStyle>
        <p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle>
    </p:txStyles>
</p:sldMaster>`;

// The layout is where a placeholder's geometry lives; slides almost never restate it.
const LAYOUT = `<p:sldLayout ${NS}><p:cSld><p:spTree>
    ${shape({ ph: "title", xfrm: xfrm(838_200, 365_125, 10_515_600, 1_325_563) })}
    ${shape({ ph: "body", idx: "1", xfrm: xfrm(838_200, 1_825_625, 10_515_600, 4_351_338) })}
</p:spTree></p:cSld></p:sldLayout>`;

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);

interface DeckParts {
    readonly slides: readonly string[];
    readonly notes?: Record<string, string>;
    readonly order?: readonly number[];
    readonly size?: readonly [number, number];
}

const deckBytes = ({ slides, notes = {}, order, size = [12_192_000, 6_858_000] }: DeckParts): Uint8Array => {
    const numbers = order ?? slides.map((_, index) => index + 1);
    const files: Record<string, Uint8Array> = {
        "ppt/presentation.xml": strToU8(
            `<p:presentation ${NS}><p:sldIdLst>${numbers
                .map((number, index) => `<p:sldId id="${256 + index}" r:id="rId${number}"/>`)
                .join("")}</p:sldIdLst><p:sldSz cx="${size[0]}" cy="${size[1]}"/><p:defaultTextStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:defaultTextStyle></p:presentation>`,
        ),
        "ppt/_rels/presentation.xml.rels": strToU8(rels(slides.map((_, index) => [`rId${index + 1}`, "slide", `slides/slide${index + 1}.xml`] as const))),
        "ppt/slideLayouts/slideLayout1.xml": strToU8(LAYOUT),
        "ppt/slideLayouts/_rels/slideLayout1.xml.rels": strToU8(rels([["rId1", "slideMaster", "../slideMasters/slideMaster1.xml"]])),
        "ppt/slideMasters/slideMaster1.xml": strToU8(MASTER),
        "ppt/slideMasters/_rels/slideMaster1.xml.rels": strToU8(rels([["rId1", "theme", "../theme/theme1.xml"]])),
        "ppt/theme/theme1.xml": strToU8(THEME),
        "ppt/media/image1.png": PNG,
    };
    for (const [index, content] of slides.entries()) {
        const number = index + 1;
        const note = notes[String(number)];
        files[`ppt/slides/slide${number}.xml`] = strToU8(content);
        files[`ppt/slides/_rels/slide${number}.xml.rels`] = strToU8(
            rels([
                ["rId1", "slideLayout", "../slideLayouts/slideLayout1.xml"],
                ["rId2", "image", "../media/image1.png"],
                ...(note === undefined ? [] : [["rId3", "notesSlide", `../notesSlides/notesSlide${number}.xml`] as const]),
            ]),
        );
        if (note !== undefined) {
            // A notes page is a slide of its own: the notes are one placeholder on it, the slide number is another.
            files[`ppt/notesSlides/notesSlide${number}.xml`] = strToU8(
                `<p:notes ${NS}><p:cSld><p:spTree>
                    ${shape({ ph: "sldNum", body: `<a:p><a:fld id="{1}" type="slidenum"><a:t>${number}</a:t></a:fld></a:p>` })}
                    ${shape({ ph: "body", body: `<a:p><a:r><a:t>${note}</a:t></a:r></a:p>` })}
                </p:spTree></p:cSld></p:notes>`,
            );
        }
    }
    return zipSync(files);
};

const textBoxes = (boxes: readonly { kind: string }[]): TextBox[] => boxes.filter((box): box is TextBox => box.kind === "text");
const words = (box: TextBox): string => box.paragraphs.flatMap((paragraph) => paragraph.runs.map((run) => run.text)).join("");

describe("reading a deck", () => {
    it("takes the slide canvas from the deck, in pixels", () => {
        const deck = readDeck(deckBytes({ slides: [slide(shape({ ph: "title", body: `<a:p><a:r><a:t>Hello</a:t></a:r></a:p>` }))] }));
        // 12192000 EMU is 13.333in, which is 1280 CSS pixels: the 16:9 canvas every modern deck uses.
        expect(deck.width).toBe(1280);
        expect(deck.height).toBe(720);
        expect(deck.slides).toHaveLength(1);
    });

    // A reordered deck keeps its part names: slide3.xml can be the first slide, and only the index says so.
    it("follows the deck's own slide order, not the part names", () => {
        const deck = readDeck(
            deckBytes({
                slides: [slide(shape({ ph: "title", body: `<a:p><a:r><a:t>First part</a:t></a:r></a:p>` })), slide(shape({ ph: "title", body: `<a:p><a:r><a:t>Second part</a:t></a:r></a:p>` }))],
                order: [2, 1],
            }),
        );
        expect(deck.slides.map((one) => words(textBoxes(one.boxes)[0] as TextBox))).toEqual(["Second part", "First part"]);
    });

    // The whole point of the layout walk: a slide's title states no position and no size, and must not land at 0,0 in
    // 18pt, which is what a reader sees without it.
    it("inherits a placeholder's geometry from the layout and its size from the master", () => {
        const deck = readDeck(deckBytes({ slides: [slide(shape({ ph: "title", body: `<a:p><a:r><a:t>Quarterly plan</a:t></a:r></a:p>` }))] }));
        const title = textBoxes(deck.slides[0]?.boxes ?? [])[0];
        // The layout's own EMU, converted: 914400 to the inch, 96 pixels to the inch.
        expect(title).toMatchObject({ x: 838_200 / 9525, y: 365_125 / 9525, width: 10_515_600 / 9525, height: 1_325_563 / 9525 });
        // 4400 is 44pt, and 44pt is 58.67 CSS pixels. Bold, centred and in the theme's major face, all from the master.
        expect(title?.paragraphs[0]?.runs[0]).toMatchObject({ size: 44 * (96 / 72), bold: true, font: "Georgia" });
        expect(title?.paragraphs[0]?.align).toBe("center");
    });

    // "Click to add title" is the layout's prompt to its author, not content; drawing the empty placeholder would put
    // an invisible box over the slide and, worse, make an empty slide look full.
    it("draws nothing for a placeholder nobody filled in", () => {
        const deck = readDeck(deckBytes({ slides: [slide(shape({ ph: "title", body: `<a:p/>` }))] }));
        expect(deck.slides[0]?.boxes).toEqual([]);
    });

    it("resolves theme colours through the master's colour map, modifiers and all", () => {
        const deck = readDeck(
            deckBytes({ slides: [slide(shape({ ph: "body", idx: "1", body: `<a:p><a:r><a:t>One point</a:t></a:r></a:p>` }))] }),
        );
        const body = textBoxes(deck.slides[0]?.boxes ?? [])[0];
        // tx1 maps to dk1, which the theme states as a system colour whose last rendered value was 1F1F1F; the master
        // then takes 65% of its lightness and adds 35%, which lands a near-black grey at #6d6d6d. A renderer that
        // ignored either step would paint this text #1F1F1F.
        expect(body?.paragraphs[0]?.runs[0]?.color).toBe("#6d6d6d");
        // The master's background, through the same map: bg1 is lt1 is white.
        expect(deck.slides[0]?.background).toBe("#ffffff");
    });

    it("carries the bullet and indent of each outline level", () => {
        const deck = readDeck(
            deckBytes({
                slides: [
                    slide(
                        shape({
                            ph: "body",
                            idx: "1",
                            body: `<a:p><a:r><a:t>Top</a:t></a:r></a:p><a:p><a:pPr lvl="1"/><a:r><a:t>Under it</a:t></a:r></a:p>`,
                        }),
                    ),
                ],
            }),
        );
        const paragraphs = textBoxes(deck.slides[0]?.boxes ?? [])[0]?.paragraphs ?? [];
        expect(paragraphs.map((paragraph) => paragraph.bullet)).toEqual(["•", "–"]);
        // 342900 and 742950 EMU: the master's own indents, not a guess from the level number.
        expect(paragraphs.map((paragraph) => Math.round(paragraph.indent))).toEqual([36, 78]);
        expect(paragraphs[1]?.runs[0]?.size).toBe(24 * (96 / 72));
    });

    it("hands a picture over as bytes a browser can draw", () => {
        const deck = readDeck(
            deckBytes({
                slides: [
                    slide(`<p:pic>
                        <p:nvPicPr><p:cNvPr id="4" name="Logo" descr="The logo"/><p:cNvPicPr/><p:nvPr/></p:nvPicPr>
                        <p:blipFill><a:blip r:embed="rId2"/></p:blipFill>
                        <p:spPr>${xfrm(1_000_000, 500_000, 2_000_000, 1_000_000)}</p:spPr>
                    </p:pic>`),
                ],
            }),
        );
        const picture = deck.slides[0]?.boxes[0] as ImageBox;
        expect(picture).toMatchObject({ kind: "image", mime: "image/png", description: "The logo" });
        expect([...picture.bytes]).toEqual([...PNG]);
    });

    // Grouping shapes rewrites their coordinates into the group's own space; without the mapping, every grouped shape
    // renders where it sat before it was grouped.
    it("places a grouped shape through its group's coordinate space", () => {
        const deck = readDeck(
            deckBytes({
                slides: [
                    slide(`<p:grpSp>
                        <p:nvGrpSpPr><p:cNvPr id="5" name="Group"/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>
                        <p:grpSpPr><a:xfrm><a:off x="1000000" y="1000000"/><a:ext cx="2000000" cy="2000000"/><a:chOff x="0" y="0"/><a:chExt cx="4000000" cy="4000000"/></a:xfrm></p:grpSpPr>
                        ${shape({ xfrm: xfrm(2_000_000, 0, 1_000_000, 1_000_000), body: `<a:p><a:r><a:t>Inside</a:t></a:r></a:p>` })}
                    </p:grpSp>`),
                ],
            }),
        );
        const box = textBoxes(deck.slides[0]?.boxes ?? [])[0];
        // Half scale: a child at 2,000,000 EMU inside a 4,000,000-wide space lands at the group's midpoint, and its
        // 1,000,000 EMU width halves with it.
        expect(box).toMatchObject({ x: 2_000_000 / 9525, y: 1_000_000 / 9525, width: 500_000 / 9525, height: 500_000 / 9525 });
    });

    it("reads a table's grid, its spans and its cell text", () => {
        const deck = readDeck(
            deckBytes({
                slides: [
                    slide(`<p:graphicFrame>
                        <p:nvGraphicFramePr><p:cNvPr id="6" name="Table"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
                        <p:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="2000000"/></p:xfrm>
                        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl>
                            <a:tblGrid><a:gridCol w="2000000"/><a:gridCol w="2000000"/></a:tblGrid>
                            <a:tr h="500000">
                                <a:tc gridSpan="2"><a:txBody><a:bodyPr/><a:p><a:r><a:t>Both columns</a:t></a:r></a:p></a:txBody></a:tc>
                                <a:tc hMerge="1"><a:txBody><a:bodyPr/><a:p/></a:txBody></a:tc>
                            </a:tr>
                            <a:tr h="500000">
                                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Left</a:t></a:r></a:p></a:txBody></a:tc>
                                <a:tc><a:txBody><a:bodyPr/><a:p><a:r><a:t>Right</a:t></a:r></a:p></a:txBody></a:tc>
                            </a:tr>
                        </a:tbl></a:graphicData></a:graphic>
                    </p:graphicFrame>`),
                ],
            }),
        );
        const table = deck.slides[0]?.boxes[0] as TableBox;
        // 2,000,000 EMU is 209.97 pixels; a table's own grid is the only thing that states its column widths.
        expect(table.columns.map((width) => Math.round(width))).toEqual([210, 210]);
        // The merged continuation carries nothing; the cell that spans it says so once.
        expect(table.rows[0]?.cells).toHaveLength(1);
        expect(table.rows[0]?.cells[0]?.colSpan).toBe(2);
        expect(table.rows[1]?.cells.map((cell) => cell.paragraphs[0]?.runs[0]?.text)).toEqual(["Left", "Right"]);
    });

    // A chart is real content this viewer cannot draw. Saying so where it sits is honest; leaving a hole is not.
    it("names a chart rather than leaving a hole where it sits", () => {
        const deck = readDeck(
            deckBytes({
                slides: [
                    slide(`<p:graphicFrame>
                        <p:nvGraphicFramePr><p:cNvPr id="7" name="Chart"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr>
                        <p:xfrm><a:off x="0" y="0"/><a:ext cx="4000000" cy="2000000"/></p:xfrm>
                        <a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId9"/></a:graphicData></a:graphic>
                    </p:graphicFrame>`),
                ],
            }),
        );
        expect(deck.slides[0]?.boxes[0]).toMatchObject({ kind: "unsupported", label: "Chart" } satisfies Partial<UnsupportedBox>);
    });

    it("carries the speaker notes, without the slide-number field they sit beside", () => {
        const deck = readDeck(
            deckBytes({
                slides: [slide(shape({ ph: "title", body: `<a:p><a:r><a:t>Hello</a:t></a:r></a:p>` }))],
                notes: { "1": "Remember to mention the deadline" },
            }),
        );
        expect(deck.slides[0]?.notes).toEqual(["Remember to mention the deadline"]);
    });

    // A deck whose index is unreadable still has its slides; the part names are the fallback, in numeric order.
    it("falls back to the parts themselves when the deck's index is broken", () => {
        const source = zipSync({
            "ppt/presentation.xml": strToU8("<p:presentation"),
            "ppt/slides/slide2.xml": strToU8(slide(shape({ body: `<a:p><a:r><a:t>Second</a:t></a:r></a:p>`, xfrm: xfrm(0, 0, 100_000, 100_000) }))),
            "ppt/slides/slide10.xml": strToU8(slide(shape({ body: `<a:p><a:r><a:t>Tenth</a:t></a:r></a:p>`, xfrm: xfrm(0, 0, 100_000, 100_000) }))),
        });
        const deck = readDeck(source);
        // Numeric order, not the string order that would put slide10 before slide2.
        expect(deck.slides.map((one) => words(textBoxes(one.boxes)[0] as TextBox))).toEqual(["Second", "Tenth"]);
        expect(deck.width).toBe(1280);
    });
});
