import { describe, test, expect } from "bun:test";
import { capsule, clip } from "./output.js";

describe("capsule", () => {
    test("names the tool, joins the fields, and gives each note its own line", () => {
        expect(capsule("webq", ["Docs home", "https://example.dev", "412 tokens"], ["robots.txt skipped 2"])).toBe(
            "webq: Docs home · https://example.dev · 412 tokens\nnote: robots.txt skipped 2\n",
        );
    });

    test("a run with nothing to admit ends after the one line", () => {
        expect(capsule("fileq", ["plan.docx", "docx"])).toBe("fileq: plan.docx · docx\n");
    });
});

describe("clip", () => {
    test("a body inside the budget is returned untouched, with no trailer to mistake for a cut", () => {
        const markdown = "# Title\n\nshort body\n";
        expect(clip(markdown, 4000, "/out/page.md", "page")).toBe(markdown);
    });

    test("a cut stops on a line boundary and names the budget, the total and the file holding the rest", () => {
        const markdown = `${Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n")}\n`;
        const clipped = clip(markdown, 20, "/out/doc.md", "document");
        expect(clipped.endsWith("\n")).toBe(true);
        expect(clipped).toContain("[cut at 20 of ");
        expect(clipped).toContain("Read /out/doc.md for the whole document]");
        // The kept part is whole lines: nothing is served half a line.
        const body = clipped.slice(0, clipped.indexOf("\n[cut at"));
        expect(body.split("\n").every((line) => line === "" || /^line \d+$/.test(line))).toBe(true);
    });

    test("a zero budget still names where the whole thing is", () => {
        expect(clip("# Long\n\nbody\n", 0, "/out/x.md", "page")).toContain("Read /out/x.md for the whole page]");
    });
});
