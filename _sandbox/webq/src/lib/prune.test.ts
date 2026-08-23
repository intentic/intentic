import { describe, expect, it } from "vitest";
import { bodyOf, type Element, parseHtml, textOf } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import { pruneTree } from "./prune.js";

const ARTICLE = `<main><article>
<h1>Real article</h1>
<p>This is the actual content of the page, a long paragraph carrying the substance of the article, dense readable text with many words and few links, exactly what a reader came for.</p>
<p>Second paragraph, also substantial, explaining details about the topic in complete sentences.</p>
</article></main>`;

const CHROME = `<nav><a href='/'>Home</a><a href='/about'>About</a><a href='/pricing'>Pricing</a></nav>
<div class='sidebar'><ul><li><a href='/a'>A</a></li><li><a href='/b'>B</a></li><li><a href='/c'>C</a></li></ul></div>
<footer><p>Copyright · <a href='/tos'>Terms</a></p></footer>
<div class='social-share'><a href='https://x.com/share'>Share on X</a></div>`;

const bodyFor = (html: string): Element => {
    const body = bodyOf(parseHtml(`<html><body>${html}</body></html>`));
    if (body === undefined) {
        throw new Error("fixture has no body");
    }
    return body;
};

describe("pruneTree", () => {
    it("keeps the article and drops navigation, sidebar, footer and share chrome", () => {
        const body = bodyFor(CHROME + ARTICLE);
        pruneTree(body);
        const markdown = renderMarkdown(body, {});
        expect(markdown).toContain("# Real article");
        expect(markdown).toContain("actual content of the page");
        expect(markdown).not.toContain("Pricing");
        expect(markdown).not.toContain("Copyright");
        expect(markdown).not.toContain("Share on X");
    });

    it("reports the share of text mass it removed", () => {
        const body = bodyFor(CHROME + ARTICLE);
        const share = pruneTree(body);
        expect(share).toBeGreaterThan(0.1);
        expect(share).toBeLessThan(1);
    });

    it("keeps link-heavy chrome when the threshold is lowered to zero", () => {
        const body = bodyFor(`<div class='sidebar'><ul><li><a href='/a'>A</a></li></ul></div>${ARTICLE}`);
        pruneTree(body, { threshold: 0 });
        expect(textOf(body)).toContain("A");
        expect(textOf(body)).toContain("Real article");
    });

    it("always strips excluded tags, whatever the threshold", () => {
        const body = bodyFor(`<script>evil()</script><noscript>enable js</noscript>${ARTICLE}`);
        pruneTree(body, { threshold: 0 });
        expect(textOf(body)).not.toContain("enable js");
    });
});
