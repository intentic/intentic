import { describe, expect, it } from "vitest";
import { parseHtml } from "./dom.js";
import { extractLinks, normalizeUrl, sameOrigin } from "./links.js";

describe("extractLinks", () => {
    it("resolves, dedupes and strips fragments, keeping the best anchor text", () => {
        const doc = parseHtml(
            `<html><body>
                <a href="/a">Alpha</a>
                <a href="/a#section"></a>
                <a href="https://other.example/x">Away</a>
                <a href="mailto:a@b.c">mail</a>
                <a href="javascript:void(0)">js</a>
            </body></html>`,
        );
        const links = extractLinks(doc, "https://ex.com/docs/");
        expect(links).toEqual([
            { url: "https://ex.com/a", text: "Alpha" },
            { url: "https://other.example/x", text: "Away" },
        ]);
    });
});

describe("normalizeUrl", () => {
    it("drops fragments and non-http schemes", () => {
        expect(normalizeUrl("https://ex.com/a#b")).toBe("https://ex.com/a");
        expect(normalizeUrl("ftp://ex.com/a")).toBeUndefined();
        expect(normalizeUrl("not a url")).toBeUndefined();
    });
});

describe("sameOrigin", () => {
    it("compares scheme, host and port", () => {
        expect(sameOrigin("https://ex.com/a", "https://ex.com/b")).toBe(true);
        expect(sameOrigin("https://ex.com/a", "https://sub.ex.com/a")).toBe(false);
        expect(sameOrigin("https://ex.com/a", "http://ex.com/a")).toBe(false);
    });
});
