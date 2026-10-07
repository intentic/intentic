import { checkPage } from "./page-check.js";

// The agent's own look at a page, in the sandbox's headless Chromium. Where the image carries no browser the check says
// so instead of failing, which is what these assert there too.

describe("checkPage", () => {
    it("lays a page out at the column width, measures it, and hands back what its scripts said and threw", async () => {
        const result = await checkPage(
            `<div style="height:300px">tall</div><script>console.log("drawn"); fetch("https://example.com").catch(() => console.error("offline")); throw new Error("boom")</script>`,
        );
        if (!result.ok) {
            expect(result.reason).toContain("browser");
            return;
        }
        expect(result.check.width).toBe(720);
        expect(result.check.contentHeight).toBeGreaterThanOrEqual(300);
        expect(result.check.contentHeight).toBeLessThan(400);
        expect(result.check.png.length).toBeGreaterThan(100);
        expect(result.check.messages.some((message) => message.text === "drawn")).toBe(true);
        expect(result.check.errors.some((error) => error.includes("boom"))).toBe(true);
    }, 60_000);
});
