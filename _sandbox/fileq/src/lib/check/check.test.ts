import { strToU8 } from "fflate";
import { deckBytes, field, inlinePicture, para, pdfBytes, pdfPagesBytes, pictureFrame, pngOfSize, tableFrame, textBox, wordBytes, workbookBytes } from "../../testing.js";
import { checkDocx } from "./docx.js";
import { leftoverText, type CheckReport } from "./finding.js";
import { checkPdf } from "./pdf.js";
import { checkPptx } from "./pptx.js";
import { estimateText, wrappedLines, type Paragraph } from "./text-fit.js";
import { checkXlsx } from "./xlsx.js";
import { parseXml } from "./xml-tree.js";

// Every checker against a document built with one known defect, and against a clean one, which must come back with
// nothing: a lint that cries wolf on a well-made deck teaches the agent to ignore it.

const found = (report: CheckReport): [string, string, string][] => report.findings.map((finding) => [finding.severity, finding.rule, finding.where]);
const messageOf = (report: CheckReport, rule: string): string => report.findings.find((finding) => finding.rule === rule)?.message ?? "";

const IMAGE = { type: "image", target: "../media/image1.png" };

describe("pptx", () => {
    test("a well-made deck has nothing to report, placeholders placed by the layout included", () => {
        const report = checkPptx(
            deckBytes({
                slides: [
                    {
                        drawings: [
                            textBox("Title 1", undefined, ["Quarterly results"], { ph: { type: "title" } }),
                            textBox("Content Placeholder 2", undefined, ["Revenue up 4%", "Costs flat"], { ph: { idx: 1 } }),
                            pictureFrame("Picture 3", { x: 8, y: 2, w: 4, h: 3 }, "rId2"),
                        ],
                        rels: { rId2: IMAGE },
                    },
                ],
                media: { "image1.png": pngOfSize(400, 300) },
            }),
        );
        expect(report.extent).toBe("1 slide");
        expect(report.findings).toEqual([]);
    });

    test("slides are numbered in the deck's order, not by their part files", () => {
        const report = checkPptx(
            deckBytes({
                slides: [
                    { drawings: [textBox("Opening", { x: 1, y: 1, w: 4, h: 1 }, ["Hello"])], partNumber: 7 },
                    { drawings: [textBox("Stray", { x: 20, y: 1, w: 2, h: 1 }, ["gone"])], partNumber: 2 },
                ],
            }),
        );
        expect(found(report)).toEqual([["error", "off-slide", 'slide 2 · "Stray"']]);
    });

    test("a drawing wholly off the slide is an error, one bleeding past an edge a warning with how far", () => {
        const report = checkPptx(
            deckBytes({
                slides: [{ drawings: [textBox("Gone", { x: 14, y: 1, w: 2, h: 1 }, ["off"]), textBox("Bleed", { x: 12, y: 1, w: 3, h: 1 }, ["partly"])] }],
            }),
        );
        expect(found(report)).toEqual([
            ["error", "off-slide", 'slide 1 · "Gone"'],
            ["warning", "off-slide", 'slide 1 · "Bleed"'],
        ]);
        expect(messageOf(report, "off-slide")).toBe("sits entirely off the slide, so no one will see it; move it onto the slide or delete it");
        expect(report.findings[1]?.message).toBe("runs 1.67 in past the right edge of the slide, where it is cut off");
    });

    test("a sliver past the edge under 1% of the slide is rounding, not a finding", () => {
        const report = checkPptx(deckBytes({ slides: [{ drawings: [textBox("Full bleed", { x: 0, y: 0, w: 13.4, h: 7.5 }, ["Cover"])] }] }));
        expect(report.findings).toEqual([]);
    });

    test("Office's own prompt left as text is an error; a TODO is a warning", () => {
        const report = checkPptx(
            deckBytes({
                slides: [
                    {
                        drawings: [
                            textBox("Title 1", undefined, ["Click to add title"], { ph: { type: "title" } }),
                            textBox("Notes", { x: 1, y: 3, w: 6, h: 1 }, ["TODO: numbers from finance"]),
                        ],
                    },
                ],
            }),
        );
        expect(found(report)).toEqual([
            ["error", "leftover-text", 'slide 1 · "Title 1"'],
            ["warning", "leftover-text", 'slide 1 · "Notes"'],
        ]);
    });

    test("an empty placeholder is a warning naming the prompt an editor sees", () => {
        const report = checkPptx(deckBytes({ slides: [{ drawings: [textBox("Title 1", undefined, [], { ph: { type: "title" } })] }] }));
        expect(found(report)).toEqual([["warning", "empty-placeholder", 'slide 1 · "Title 1"']]);
        expect(messageOf(report, "empty-placeholder")).toBe(
            'empty title placeholder: invisible in the slide show, but it reads "Click to add title" to anyone who edits the deck; fill it or delete it',
        );
    });

    test("a picture whose image is not in the file, or whose relationship is not defined, is an error", () => {
        const report = checkPptx(
            deckBytes({
                slides: [
                    {
                        drawings: [pictureFrame("Gone", { x: 1, y: 1, w: 4, h: 3 }, "rId2"), pictureFrame("Undefined", { x: 6, y: 1, w: 4, h: 3 }, "rId9")],
                        rels: { rId2: { type: "image", target: "../media/missing.png" } },
                    },
                ],
            }),
        );
        expect(found(report)).toEqual([
            ["error", "missing-image", 'slide 1 · "Gone"'],
            ["error", "missing-image", 'slide 1 · "Undefined"'],
        ]);
        expect(report.findings[0]?.message).toBe("image ppt/media/missing.png is not in the file, so it shows as a broken image");
    });

    test("an image linked from outside the file is a warning naming where it points", () => {
        const report = checkPptx(
            deckBytes({
                slides: [{ drawings: [pictureFrame("Logo", { x: 1, y: 1, w: 4, h: 3 }, "rId2")], rels: { rId2: { type: "image", target: "file:///C:/Users/me/logo.png", external: true } } }],
            }),
        );
        expect(found(report)).toEqual([["warning", "linked-image", 'slide 1 · "Logo"']]);
        expect(messageOf(report, "linked-image")).toContain("file:///C:/Users/me/logo.png");
    });

    test("a stretched picture is a warning; a crop that removes it all is an error", () => {
        const report = checkPptx(
            deckBytes({
                slides: [
                    {
                        drawings: [pictureFrame("Wide", { x: 1, y: 1, w: 4, h: 1 }, "rId2"), pictureFrame("Cropped", { x: 6, y: 1, w: 4, h: 3 }, "rId2", { l: 60_000, r: 40_000 })],
                        rels: { rId2: IMAGE },
                    },
                ],
                media: { "image1.png": pngOfSize(400, 300) },
            }),
        );
        expect(found(report)).toEqual([
            ["error", "bad-crop", 'slide 1 · "Cropped"'],
            ["warning", "stretched-image", 'slide 1 · "Wide"'],
        ]);
        expect(messageOf(report, "stretched-image")).toBe(
            "the picture is stretched wide: its box is 4.00:1, the image 1.33:1; set one side from the other, or crop instead",
        );
    });

    test("a picture cropped to its box's proportions is not stretched", () => {
        const report = checkPptx(
            deckBytes({
                slides: [{ drawings: [pictureFrame("Banner", { x: 1, y: 1, w: 4, h: 1.5 }, "rId2", { t: 25_000, b: 25_000 })], rels: { rId2: IMAGE } }],
                media: { "image1.png": pngOfSize(400, 300) },
            }),
        );
        expect(report.findings).toEqual([]);
    });

    test("text that cannot fit its box is a warning with the estimate, pointing at render", () => {
        const long = "This is a very long sentence that will surely not fit in a small box of three inches at twenty four points, and it goes on and on.";
        const report = checkPptx(
            deckBytes({
                slides: [
                    { drawings: [textBox("Opening", { x: 1, y: 1, w: 4, h: 1 }, ["Hello"])] },
                    { drawings: [textBox("Callout", { x: 1, y: 1, w: 3, h: 0.6 }, [long], { size: 24 })] },
                ],
            }),
        );
        expect(found(report)).toEqual([["warning", "text-overflow", 'slide 2 · "Callout"']]);
        expect(messageOf(report, "text-overflow")).toBe(
            "text probably overflows its box: about 7 lines of 24 pt need 2.9 in, the box is 0.6 in tall; shorten it, enlarge the box or split the slide (an estimate: look with `fileq render --pages 2`)",
        );
    });

    test("text that fits, and a box that grows to fit its text on the slide, say nothing", () => {
        const report = checkPptx(
            deckBytes({
                slides: [
                    {
                        drawings: [
                            textBox("Fits", { x: 1, y: 1, w: 6, h: 1.2 }, ["Two lines of", "comfortable text"], { size: 24 }),
                            textBox("Grows", { x: 1, y: 3, w: 3, h: 0.5 }, ["A sentence long enough to need three or four lines here."], { size: 18, autofit: "grow" }),
                        ],
                    },
                ],
            }),
        );
        expect(report.findings).toEqual([]);
    });

    test("shrink-on-overflow says PowerPoint shows it overflowing until edited", () => {
        const long = "A paragraph much too long for its box, which PowerPoint only shrinks once somebody edits the text and LibreOffice shrinks at once.";
        const report = checkPptx(deckBytes({ slides: [{ drawings: [textBox("Body", { x: 1, y: 1, w: 3, h: 0.6 }, [long], { size: 24, autofit: "shrink" })] }] }));
        expect(messageOf(report, "text-overflow")).toContain("shrink-on-overflow is on, so LibreOffice shrinks it but PowerPoint shows it overflowing until the text is edited");
    });

    test("a table whose rows run past the bottom of the slide is a warning", () => {
        const rows = Array.from({ length: 16 }, (_, index) => [`Region ${index}`, "A value", "Another"]);
        const report = checkPptx(deckBytes({ slides: [{ drawings: [tableFrame("Table 1", { x: 0.5, y: 1.5, w: 12, h: 3 }, rows, 0.4)] }] }));
        expect(found(report)).toEqual([["warning", "table-overflow", 'slide 1 · "Table 1"']]);
    });

    test("a hidden slide is a warning", () => {
        const report = checkPptx(deckBytes({ slides: [{ drawings: [textBox("Backup", { x: 1, y: 1, w: 4, h: 1 }, ["Spare"])], hidden: true }] }));
        expect(found(report)).toEqual([["warning", "hidden-slide", "slide 1"]]);
    });

    test("a part with no content type is damage Office repairs", () => {
        const report = checkPptx(
            deckBytes({
                slides: [{ drawings: [pictureFrame("Photo", { x: 1, y: 1, w: 4, h: 3 }, "rId2")], rels: { rId2: IMAGE } }],
                media: { "image1.png": pngOfSize(400, 300) },
                untypedMedia: true,
            }),
        );
        expect(found(report)).toEqual([["error", "content-type", ""]]);
        expect(messageOf(report, "content-type")).toContain("no content type for part ppt/media/image1.png");
    });

    test("a file that is not a zip is one error, not a crash", () => {
        const report = checkPptx(strToU8("not a deck"));
        expect(found(report)).toEqual([["error", "unreadable", ""]]);
    });

    test("a nameless drawing is named by its kind and id", () => {
        const nameless = textBox("", { x: 20, y: 1, w: 2, h: 1 }, ["far"]);
        const report = checkPptx(deckBytes({ slides: [{ drawings: [nameless] }] }));
        expect(report.findings[0]?.where).toMatch(/^slide 1 · unnamed shape #\d+$/);
    });
});

const DOC_IMAGE = { type: "image", target: "media/image1.png" };

describe("docx", () => {
    test("a well-made document has nothing to report", () => {
        const report = checkDocx(
            wordBytes({
                body: [para("Report", "berschrift1"), para("The body of the report."), '<w:p><w:bookmarkStart w:id="0" w:name="results"/><w:bookmarkEnd w:id="0"/></w:p>', '<w:p><w:hyperlink w:anchor="results"><w:r><w:t>see results</w:t></w:r></w:hyperlink></w:p>', inlinePicture("rId5", 6, 3), field("PAGE", "1")],
                rels: { rId5: DOC_IMAGE },
                media: { "image1.png": pngOfSize(600, 300) },
            }),
        );
        expect(report.extent).toBe("6 paragraphs");
        expect(report.findings).toEqual([]);
    });

    test("a link to a bookmark that is not there is an error, located by its paragraph", () => {
        const report = checkDocx(wordBytes({ body: [para("Intro", "berschrift1"), '<w:p><w:hyperlink w:anchor="nowhere"><w:r><w:t>see section</w:t></w:r></w:hyperlink></w:p>'] }));
        expect(found(report)).toEqual([["error", "broken-link", 'paragraph 2 · "see section"']]);
        expect(messageOf(report, "broken-link")).toBe('the link "see section" points to bookmark "nowhere", which is not in the document, so clicking it goes nowhere');
    });

    test("a cross-reference to a missing bookmark, and a field showing Word's error, are errors said once", () => {
        const report = checkDocx(wordBytes({ body: [field("PAGEREF _Ref999 \\h", "3"), field("REF _Ref123 \\h", "Error! Reference source not found.")] }));
        expect(found(report)).toEqual([
            ["error", "broken-reference", 'paragraph 1 · "3"'],
            ["error", "field-error", 'paragraph 2 · "Error! Reference source not found."'],
        ]);
    });

    test("a table of contents with no saved entries is a warning", () => {
        const report = checkDocx(wordBytes({ body: [para("Contents"), field('TOC \\o "1-3" \\h', undefined), para("Body", "berschrift1")] }));
        expect(found(report)).toEqual([["warning", "empty-toc", "paragraph 2"]]);
    });

    test("an empty heading is found through the style's name, whatever its id, and through basedOn", () => {
        const report = checkDocx(wordBytes({ body: [para("Results", "berschrift1"), para("", "berschrift2"), para("", "Callout"), para("Text.")] }));
        expect(found(report)).toEqual([
            ["warning", "empty-heading", 'paragraph 2 · under "Results"'],
            ["warning", "empty-heading", 'paragraph 3 · under "Results"'],
        ]);
    });

    test("a missing image is an error, one wider than the text column a warning", () => {
        const report = checkDocx(
            wordBytes({
                body: [inlinePicture("rId5", 9, 3), inlinePicture("rId6", 2, 2)],
                rels: { rId5: DOC_IMAGE, rId6: { type: "image", target: "media/missing.png" } },
                media: { "image1.png": pngOfSize(900, 300) },
            }),
        );
        expect(found(report)).toEqual([
            ["error", "missing-image", "paragraph 2"],
            ["warning", "wide-image", "paragraph 1"],
        ]);
        expect(messageOf(report, "wide-image")).toBe("a picture is 9 in wide in a 6.5 in text column, so it runs into the margin or is cut off; scale it to fit");
    });

    test("what a draft leaves behind: tracked changes, comments, a control showing its prompt, filler text", () => {
        const report = checkDocx(
            wordBytes({
                body: [
                    '<w:p><w:ins w:id="1" w:author="a"><w:r><w:t>new words</w:t></w:r></w:ins></w:p>',
                    '<w:sdt><w:sdtPr><w:showingPlcHdr/></w:sdtPr><w:sdtContent><w:p><w:r><w:t>Click or tap here to enter text.</w:t></w:r></w:p></w:sdtContent></w:sdt>',
                    para("Lorem ipsum dolor sit amet."),
                ],
                comments: ["check this figure"],
            }),
        );
        expect(found(report)).toEqual([
            ["error", "placeholder-control", 'paragraph 2 · "Click or tap here to enter text."'],
            ["error", "leftover-text", 'paragraph 3 · "Lorem ipsum dolor sit amet."'],
            ["warning", "tracked-changes", ""],
            ["warning", "comments", ""],
        ]);
    });

    test("typed bullets are one warning with their count, at the first", () => {
        const report = checkDocx(wordBytes({ body: [para("• first"), para("• second"), para("Plain.")] }));
        expect(found(report)).toEqual([["warning", "typed-bullets", 'paragraph 1 · "• first"']]);
        expect(messageOf(report, "typed-bullets")).toBe(
            "2 paragraphs start with a typed bullet character instead of a list style, so the list will not indent or renumber; use a list style",
        );
    });
});

const cell = (ref: string, inner: string, type?: string): string => `<c r="${ref}"${type === undefined ? "" : ` t="${type}"`}>${inner}</c>`;

describe("xlsx", () => {
    test("a workbook of values and computed formulas has nothing to report", () => {
        const report = checkXlsx(workbookBytes([{ name: "Sheet1", rows: `<row r="1">${cell("A1", "<v>1</v>")}${cell("B1", "<f>A1*2</f><v>2</v>")}</row>` }]));
        expect(report.extent).toBe("1 sheet");
        expect(report.findings).toEqual([]);
    });

    test("an error value is an error at its cell with its formula; a sheet name with a space is quoted", () => {
        const report = checkXlsx(workbookBytes([{ name: "Q3 plan", rows: `<row r="4">${cell("C4", "<f>A4/B4</f><v>#DIV/0!</v>", "e")}</row>` }]));
        expect(found(report)).toEqual([["error", "formula-error", "'Q3 plan'!C4"]]);
        expect(messageOf(report, "formula-error")).toBe("shows #DIV/0! from =A4/B4: fix the formula or its inputs");
    });

    test("a formula pointing at a deleted range is an error even with a value saved", () => {
        const report = checkXlsx(workbookBytes([{ name: "Data", rows: `<row r="1">${cell("A1", "<f>SUM(#REF!)</f><v>0</v>")}</row>` }]));
        expect(found(report)).toEqual([["error", "formula-error", "Data!A1"]]);
    });

    test("formulas saved without a value are one warning per sheet, and say whether the workbook recalculates on open", () => {
        const rows = `<row r="1">${cell("A1", "<v>1</v>")}${cell("B1", "<f>A1+1</f>")}${cell("C1", "<f>A1+2</f>")}</row>`;
        const plain = checkXlsx(workbookBytes([{ name: "Data", rows }]));
        expect(found(plain)).toEqual([["warning", "formula-uncached", "Data"]]);
        expect(messageOf(plain, "formula-uncached")).toContain("2 formulas saved with no value (B1, C1): Excel, LibreOffice and Google Sheets compute them on open");
        const flagged = checkXlsx(workbookBytes([{ name: "Data", rows }], { calcPr: '<calcPr fullCalcOnLoad="1"/>' }));
        expect(messageOf(flagged, "formula-uncached")).toContain("the workbook asks to be recalculated on open");
    });

    test("past ten error cells on a sheet, the rest are counted", () => {
        const rows = `<row r="1">${Array.from({ length: 13 }, (_, index) => cell(`A${index + 1}`, "<v>#N/A</v>", "e")).join("")}</row>`;
        const report = checkXlsx(workbookBytes([{ name: "Data", rows }]));
        expect(report.findings).toHaveLength(11);
        expect(report.findings.at(-1)?.message).toBe("and 3 more cells with errors on this sheet");
    });

    test("a defined name pointing at a deleted range is an error; an empty workbook a warning", () => {
        const report = checkXlsx(workbookBytes([{ name: "Data", rows: "" }], { definedNames: '<definedName name="Total">#REF!$A$1</definedName>' }));
        expect(found(report)).toEqual([
            ["warning", "no-data", ""],
            ["error", "broken-name", ""],
        ]);
    });
});

describe("pdf", () => {
    test("a page of text in a standard font has nothing to report", async () => {
        const report = await checkPdf(pdfBytes("Hello world, this is a page."));
        expect(report.extent).toBe("1 page");
        expect(report.findings).toEqual([]);
    });

    test("a blank page is an error; a page with only a drawing is not blank", async () => {
        const report = await checkPdf(pdfPagesBytes([{ content: "BT /F1 12 Tf 72 720 Td (Cover) Tj ET" }, { content: "" }, { content: "0 0 1 rg 10 10 100 100 re f" }]));
        expect(found(report)).toEqual([["error", "blank-page", "page 2"]]);
    });

    test("text in a font the file does not carry is a warning; the fourteen standard fonts are not", async () => {
        const report = await checkPdf(pdfPagesBytes([{ content: "BT /F1 12 Tf 72 720 Td (Hello) Tj ET", font: "Calibri" }, { content: "BT /F1 12 Tf 72 720 Td (Again) Tj ET", font: "Calibri" }]));
        expect(found(report)).toEqual([["warning", "font-not-embedded", "page 1, 2"]]);
        expect(messageOf(report, "font-not-embedded")).toContain("text is set in Calibri, which the file does not carry");
    });

    test("a page of another size is a warning naming both sizes", async () => {
        const text = "BT /F1 12 Tf 72 500 Td (Page) Tj ET";
        const report = await checkPdf(pdfPagesBytes([{ content: text }, { content: text, size: [792, 612] }, { content: text }]));
        expect(found(report)).toEqual([["warning", "page-size", "page 2"]]);
        expect(messageOf(report, "page-size")).toBe("1 page is 11 × 8.5 in, the rest 8.5 × 11 in");
    });

    test("a link to a named destination the file does not define is an error", async () => {
        const report = await checkPdf(
            pdfPagesBytes([{ content: "BT /F1 12 Tf 72 720 Td (See results) Tj ET", extra: "/Annots [<< /Type /Annot /Subtype /Link /Rect [72 700 200 730] /Dest (results) >>]" }]),
        );
        expect(found(report)).toEqual([["error", "broken-link", "page 1"]]);
    });

    test("a document with no text layer at all is a warning", async () => {
        const report = await checkPdf(pdfPagesBytes([{ content: "0 0 1 rg 10 10 100 100 re f" }]));
        expect(found(report)).toEqual([["warning", "no-text-layer", ""]]);
    });

    test("bytes that are not a PDF are one error", async () => {
        const report = await checkPdf(strToU8("not a pdf"));
        expect(found(report)).toEqual([["error", "unreadable", ""]]);
    });
});

describe("leftover text", () => {
    test("the first certain match wins, quoted; a likely one is a warning; ordinary words are nothing", () => {
        expect(leftoverText("Click to add subtitle", "x").map((finding) => [finding.severity, finding.message])).toEqual([
            ["error", 'leftover template text "Click to add subtitle": replace it with the real content or delete it'],
        ]);
        expect(leftoverText("Venue: TBD", "x").map((finding) => finding.severity)).toEqual(["warning"]);
        expect(leftoverText("Dear {{first_name}},", "x").map((finding) => finding.severity)).toEqual(["warning"]);
        expect(leftoverText("Click the button to add a row.", "x")).toEqual([]);
        expect(leftoverText("A todo list for the team", "x")).toEqual([]);
    });
});

describe("xml tree", () => {
    test("a part written under other prefixes reads under the specification's", () => {
        const tree = parseXml(
            '<ns0:sld xmlns:ns0="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:ns1="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><ns0:cSld ns1:id="rId1"/></ns0:sld>',
        );
        expect(tree.name).toBe("p:sld");
        expect(tree.children).toEqual([{ name: "p:cSld", attrs: { "r:id": "rId1" }, children: [] }]);
    });

    test("entities decode, CDATA is text, whitespace is kept only inside a text element", () => {
        const tree = parseXml('<w:p xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n  <w:t> A &amp; B </w:t><w:t><![CDATA[<raw>]]></w:t>\n</w:p>');
        expect(tree.children).toEqual([
            { name: "w:t", attrs: {}, children: [" A & B "] },
            { name: "w:t", attrs: {}, children: ["<raw>"] },
        ]);
    });
});

describe("text fit", () => {
    const paragraph = (text: string, sizePt = 18): Paragraph => ({ text, sizePt, bold: false, lineSpacing: 1, spaceBeforePt: 0, spaceAfterPt: 0 });

    test("a line that fits is one line; a hard break is another; a word wider than the column breaks", () => {
        expect(wrappedLines(paragraph("short"), 200)).toBe(1);
        expect(wrappedLines(paragraph("one\ntwo"), 200)).toBe(2);
        expect(wrappedLines(paragraph("x".repeat(40), 10), 100)).toBe(3);
    });

    test("height is lines times 1.2 of the size, plus the spacing between paragraphs", () => {
        const estimate = estimateText([{ ...paragraph("a", 20), spaceAfterPt: 6 }, paragraph("b", 20)], 500, true);
        expect(estimate).toEqual({ heightPt: 54, lines: 2, widestPt: 10.4, sizePt: 20 });
    });
});
