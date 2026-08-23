import { describe, expect, it } from "vitest";
import { fetchSitemapUrls } from "./sitemap.js";

const stub =
    (map: Record<string, string>) =>
    (url: string): Promise<{ body: string } | undefined> =>
        Promise.resolve(map[url] === undefined ? undefined : { body: map[url] });

describe("fetchSitemapUrls", () => {
    it("reads a urlset, decoding entities and normalizing", async () => {
        const seed = await fetchSitemapUrls(
            "https://ex.com/start",
            [],
            stub({
                "https://ex.com/sitemap.xml": `<urlset><url><loc> https://ex.com/a </loc></url><url><loc>https://ex.com/b?x=1&amp;y=2</loc></url></urlset>`,
            }),
        );
        expect(seed.urls).toEqual(["https://ex.com/a", "https://ex.com/b?x=1&y=2"]);
        expect(seed.capped).toBe(false);
    });

    it("follows one level of sitemap index and prefers robots-declared sitemaps", async () => {
        const seed = await fetchSitemapUrls(
            "https://ex.com/",
            ["https://ex.com/custom.xml"],
            stub({
                "https://ex.com/custom.xml": `<sitemapindex><sitemap><loc>https://ex.com/part1.xml</loc></sitemap></sitemapindex>`,
                "https://ex.com/part1.xml": `<urlset><url><loc>https://ex.com/deep</loc></url></urlset>`,
            }),
        );
        expect(seed.urls).toEqual(["https://ex.com/deep"]);
    });

    it("returns empty when no sitemap answers", async () => {
        const seed = await fetchSitemapUrls("https://ex.com/", [], stub({}));
        expect(seed.urls).toEqual([]);
    });
});
