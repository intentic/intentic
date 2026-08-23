import { describe, expect, it } from "vitest";
import { isAllowed, parseRobots } from "./robots.js";

describe("parseRobots", () => {
    it("takes the wildcard group and reads sitemaps and crawl-delay", () => {
        const rules = parseRobots(
            [
                "User-agent: googlebot",
                "Disallow: /google-only",
                "",
                "User-agent: *",
                "Disallow: /private",
                "Crawl-delay: 2",
                "",
                "Sitemap: https://ex.com/sitemap.xml",
            ].join("\n"),
        );
        expect(rules.disallows).toEqual(["/private"]);
        expect(rules.crawlDelayS).toBe(2);
        expect(rules.sitemaps).toEqual(["https://ex.com/sitemap.xml"]);
    });

    it("prefers a group naming webq over the wildcard", () => {
        const rules = parseRobots(["User-agent: *", "Disallow: /", "", "User-agent: webq", "Disallow: /only-this"].join("\n"));
        expect(rules.disallows).toEqual(["/only-this"]);
    });

    it("lets several user-agent lines share one group", () => {
        const rules = parseRobots(["User-agent: a", "User-agent: *", "Disallow: /x"].join("\n"));
        expect(rules.disallows).toEqual(["/x"]);
    });
});

describe("isAllowed", () => {
    it("applies longest-match-wins with allow beating disallow on ties", () => {
        const rules = parseRobots(["User-agent: *", "Disallow: /docs", "Allow: /docs/public"].join("\n"));
        expect(isAllowed(rules, "/docs/private")).toBe(false);
        expect(isAllowed(rules, "/docs/public/page")).toBe(true);
        expect(isAllowed(rules, "/other")).toBe(true);
    });

    it("supports * wildcards and $ end anchors", () => {
        const rules = parseRobots(["User-agent: *", "Disallow: /*.pdf$", "Disallow: /tmp/*"].join("\n"));
        expect(isAllowed(rules, "/report.pdf")).toBe(false);
        expect(isAllowed(rules, "/report.pdf.html")).toBe(true);
        expect(isAllowed(rules, "/tmp/x/y")).toBe(false);
    });

    it("treats an empty disallow as allow-all", () => {
        const rules = parseRobots(["User-agent: *", "Disallow:"].join("\n"));
        expect(isAllowed(rules, "/anything")).toBe(true);
    });
});
