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

    it("draws the page inside a frame as the chat does: its first script already sees the column's width", async () => {
        const result = await checkPage(
            `<div id="c"></div><script>var w = document.getElementById("c").clientWidth; console.log("width " + w); if (w === 0) throw new Error("drew into nothing")</script>`,
        );
        if (!result.ok) {
            expect(result.reason).toContain("browser");
            return;
        }
        expect(result.check.messages.some((message) => message.text === "width 720")).toBe(true);
        expect(result.check.errors).toEqual([]);
        expect(result.check.followsFrame).toBe(false);
    }, 60_000);

    it("says when a page's height follows its frame rather than its content, and what a rejected promise threw", async () => {
        const result = await checkPage(`<style>body{height:100vh;box-sizing:border-box;padding:16px}</style><p>fills</p><script>Promise.reject("nope")</script>`);
        if (!result.ok) {
            expect(result.reason).toContain("browser");
            return;
        }
        expect(result.check.followsFrame).toBe(true);
        expect(result.check.errors.some((error) => error.includes("nope"))).toBe(true);
    }, 60_000);

    // The check waits for the reported height to hold still rather than a fixed 600ms (2026-10-20): a page still
    // growing is measured once it stops, and one that is done does not wait out the old fixed beats.
    // Each step inside the quiet window of the last; a page that sits still longer than that and then grows is measured
    // before it grows, which the cap would not have caught either past 600ms.
    it("measures a page that grows in steps after load at the height it settles on", async () => {
        const result = await checkPage(
            `<div id="g" style="height:100px"></div><script>[60, 130, 200].forEach((ms, i) => setTimeout(() => (document.getElementById("g").style.height = (200 + i * 100) + "px"), ms))</script>`,
        );
        if (!result.ok) {
            expect(result.reason).toContain("browser");
            return;
        }
        expect(result.check.contentHeight).toBeGreaterThanOrEqual(400);
        expect(result.check.contentHeight).toBeLessThan(500);
    }, 60_000);

    it("answers a settled page well inside the old fixed 1.1s of waiting, once its browser is warm", async () => {
        const page = `<div style="height:240px">still</div>`;
        const warm = await checkPage(page);
        if (!warm.ok) {
            expect(warm.reason).toContain("browser");
            return;
        }
        const started = performance.now();
        const result = await checkPage(page);
        const took = performance.now() - started;
        expect(result.ok && result.check.contentHeight).toBeGreaterThanOrEqual(240);
        // ~0.47s measured against ~1.25s before; the bound leaves a loaded machine room.
        expect(took).toBeLessThan(1_100);
    }, 60_000);
});
