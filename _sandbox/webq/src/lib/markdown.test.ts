import { describe, expect, it } from "vitest";
import { bodyOf, parseHtml } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

const md = (html: string, baseUrl?: string): string => {
    const body = bodyOf(parseHtml(`<html><body>${html}</body></html>`));
    if (body === undefined) {
        throw new Error("fixture has no body");
    }
    return renderMarkdown(body, baseUrl === undefined ? {} : { baseUrl });
};

describe("renderMarkdown", () => {
    it("renders headings, paragraphs and inline marks", () => {
        expect(md("<h2>Title</h2><p>Plain <strong>bold</strong> <em>italic</em> <code>code()</code>.</p>")).toBe(
            "## Title\n\nPlain **bold** *italic* `code()`.\n",
        );
    });

    it("pools loose container text into its own paragraph (flow)", () => {
        expect(md("<div>loose text<p>inner</p></div>")).toBe("loose text\n\ninner\n");
    });

    it("renders nested lists with indentation and honors ol start", () => {
        expect(md("<ul><li>one</li><li>two<ul><li>two-a</li></ul></li></ul><ol start='3'><li>three</li></ol>")).toBe(
            "- one\n- two\n    - two-a\n\n3. three\n",
        );
    });

    it("fences code with its language and outsizes inner backtick runs", () => {
        expect(md("<pre><code class='language-ts'>const x = `hi`;</code></pre>")).toBe("```ts\nconst x = `hi`;\n```\n");
        expect(md("<pre><code>a ``` b</code></pre>")).toBe("````\na ``` b\n````\n");
    });

    it("renders GFM tables, escaping pipes and taking th as header", () => {
        expect(md("<table><thead><tr><th>A</th><th>B|C</th></tr></thead><tbody><tr><td>1</td><td>2</td></tr></tbody></table>")).toBe(
            "| A | B\\|C |\n| --- | --- |\n| 1 | 2 |\n",
        );
    });

    it("absolutizes links against the page URL and unwraps unlinkable ones", () => {
        expect(md("<p><a href='/x'>rel</a> <a href='javascript:alert(1)'>js</a> <a href='mailto:a@b.c'>mail</a></p>", "https://ex.com/docs/")).toBe(
            "[rel](https://ex.com/x) js mail\n",
        );
    });

    it("absolutizes images and drops data: blobs to their alt text", () => {
        expect(md("<p><img src='pic.png' alt='Pic'> <img src='data:image/png;base64,x' alt='blob'></p>", "https://ex.com/d/")).toBe(
            "![Pic](https://ex.com/d/pic.png) blob\n",
        );
    });

    it("prefixes every blockquote line, including inner blank ones", () => {
        expect(md("<blockquote><p>one</p><p>two</p></blockquote>")).toBe("> one\n>\n> two\n");
    });

    it("keeps br as a line break inside a paragraph", () => {
        expect(md("<p>first<br>second</p>")).toBe("first\nsecond\n");
    });

    it("collapses whitespace runs and decodes entities", () => {
        expect(md("<p>a\n\t   b &amp; c</p>")).toBe("a b & c\n");
    });

    it("skips script, style and their text entirely", () => {
        expect(md("<p>keep</p><script>drop()</script><style>.x{}</style>")).toBe("keep\n");
    });
});
