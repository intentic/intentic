import { estimateTokens } from "@intentic/base/format";
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

// What came before the trailer, and the trailer itself.
const split = (clipped: string) => {
    const at = clipped.lastIndexOf("\n[cut ");
    const trailer = clipped.slice(at + 1);
    const printed = clipped.slice(0, at);
    // A cut inside a line is ended on screen by a newline the markdown does not have there.
    return { body: trailer.includes("characters into line") ? printed.slice(0, -1) : printed, trailer };
};

describe("clip", () => {
    test("a body inside the budget is returned untouched, with no trailer to mistake for a cut", () => {
        const markdown = "# Title\n\nshort body\n";
        expect(clip(markdown, 4000, { file: "/out/page.md", firstLine: 1 })).toBe(markdown);
    });

    test("a body exactly at the budget is whole; one token less cuts it", () => {
        const markdown = `${Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n")}\n`;
        const exact = estimateTokens(markdown);
        expect(clip(markdown, exact, { file: "/out/doc.md", firstLine: 1 })).toBe(markdown);
        expect(clip(markdown, exact - 1, { file: "/out/doc.md", firstLine: 1 })).toContain("\n[cut at line ");
    });

    test("a cut stops on a line boundary and names the line the rest starts on, in the saved file's numbering", () => {
        const lines = Array.from({ length: 200 }, (_, index) => `line ${index + 1}`);
        const markdown = `${lines.join("\n")}\n`;
        // Five lines of front matter above the body: the body's line 1 is the file's line 6.
        const saved = `---\nurl: x\ntitle: "y"\nsource: network\n---\n${markdown}`;
        const clipped = clip(markdown, 20, { file: "/out/doc.md", firstLine: 6 });
        const { body, trailer } = split(clipped);
        expect(clipped.endsWith("]\n")).toBe(true);
        // The kept part is whole lines: nothing is served half a line.
        expect(body.endsWith("\n")).toBe(true);
        expect(body.split("\n").every((line) => line === "" || /^line \d+$/.test(line))).toBe(true);
        // Cut by the estimate that counted it: what is kept fits the budget it names.
        expect(estimateTokens(body)).toBeLessThanOrEqual(20);
        const shown = body.trimEnd().split("\n").length;
        // The line Read shows at the resume number is the first line that was not printed.
        const resume = Number(/from line (\d+),/.exec(trailer)?.[1]);
        expect(saved.split("\n")[resume - 1]).toBe(`line ${shown + 1}`);
        expect(trailer).toBe(
            `[cut at line ${resume} of 205, ~${estimateTokens(markdown.slice(body.length)).toLocaleString("en-US")} of ` +
                `${estimateTokens(markdown).toLocaleString("en-US")} tokens left: continue with Read /out/doc.md from line ${resume}, or raise --budget]\n`,
        );
    });

    test("one line longer than the budget is cut inside, between words, instead of coming back empty", () => {
        const paragraph = Array.from({ length: 2000 }, (_, index) => `word${index % 7 === 0 ? "," : ""}`).join(" ");
        const clipped = clip(paragraph, 50, { file: "/out/page.md", firstLine: 4 });
        const { body, trailer } = split(clipped);
        expect(body.length).toBeGreaterThan(0);
        expect(estimateTokens(body)).toBeLessThanOrEqual(50);
        expect(paragraph.startsWith(body)).toBe(true);
        // It stops at the end of a word, not inside one.
        expect(paragraph.charAt(body.length)).toBe(" ");
        expect(trailer).toContain(`cut ${body.length.toLocaleString("en-US")} characters into line 4 of 4,`);
        expect(trailer).toContain("continue with Read /out/page.md from line 4, or raise --budget]");
    });

    test("a title above one long paragraph spends the budget on the paragraph, not on the title alone", () => {
        const markdown = `# Title\n${"lorem ipsum dolor sit amet ".repeat(400)}\nlast line\n`;
        const { body, trailer } = split(clip(markdown, 100, { file: "/out/page.md", firstLine: 1 }));
        expect(body.startsWith("# Title\nlorem ipsum")).toBe(true);
        expect(estimateTokens(body)).toBeGreaterThan(50);
        expect(trailer).toContain("characters into line 2 of 3,");
    });

    test("a single word no budget holds is still cut, not dropped", () => {
        const base64 = "QWxhZGRpbjpvcGVuIHNlc2FtZQ".repeat(400);
        const { body } = split(clip(base64, 10, { file: "/out/blob.md", firstLine: 1 }));
        expect(body.length).toBeGreaterThan(0);
        expect(estimateTokens(body)).toBeLessThanOrEqual(10);
        expect(base64.startsWith(body)).toBe(true);
    });

    test("with no file saved, the continuation is the command that prints it whole", () => {
        const markdown = `${Array.from({ length: 100 }, (_, index) => `row ${index + 1}`).join("\n")}\n`;
        const { body, trailer } = split(clip(markdown, 10, { command: "fileq read --plain '/tmp/a b.docx'" }));
        const resume = body.trimEnd().split("\n").length + 1;
        expect(trailer).toContain(`continue with \`fileq read --plain '/tmp/a b.docx' | tail -n +${resume}\`, or raise --budget]`);
    });

    test("a zero budget still names where the whole thing is, from its first line", () => {
        const markdown = "# Long\n\nbody\n";
        const total = estimateTokens(markdown);
        expect(clip(markdown, 0, { file: "/out/x.md", firstLine: 7 })).toBe(
            `\n[cut at line 7 of 9, ~${total} of ${total} tokens left: continue with Read /out/x.md from line 7, or raise --budget]\n`,
        );
    });
});
