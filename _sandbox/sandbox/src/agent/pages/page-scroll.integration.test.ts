import { existsSync } from "node:fs";
import { requires } from "@intentic/testing/requires";
import { PAGE_FALLBACK_THEMES, publishedPage, sealedPage, sizedFirst, standalonePage } from "@intentic/sandbox-contract/text/pages";
import type { Browser, Frame, Page } from "playwright";

/* A page's scripted scrolling, in a real Chromium, inside a sandboxed frame across a chat that scrolls: what the page
   scrolls into view or focuses as it loads moves the scrollers inside it and its own viewport, never the chat around it
   (the bootstrap's CONTAINED_SCROLL); right after the reader's own press in the page, the browser's own scroll runs. The
   frame is built the way the chat builds it (sealed, then held until it has a width) and the way a published
   conversation frames a stored page. */

let playwright: typeof import("playwright") | undefined;
try {
    playwright = await import("playwright");
} catch {
    playwright = undefined;
}
const chromium = requires(playwright !== undefined && existsSync(playwright.chromium.executablePath()), "Playwright's Chromium", {
    absentOnCi: "no CI job that runs the daemon's suites installs the browser pack; the sandbox image carries it",
});

// Where the chat stands while the page loads: a stretch of transcript above the frame, the frame, and more below.
const ABOVE = 2000;
const TALL = `<div style="height:1500px">top</div><input id="x"><div id="t">target</div><div style="height:1500px"></div>`;

const escaped = (html: string): string => html.replace(/&/g, `&amp;`).replace(/"/g, `&quot;`);
// The chat marks itself once the page says it has acted, so the test waits on the chat's own document. It never reaches
// into the frame before then: Playwright evaluates with a user gesture, which would hand the frame the very activation a
// reader's press gives it, and the page's scroll would then rightly be let through.
const chatAround = (frameDocument: string, frameHeight: number): string =>
    `<!doctype html><html><body style="margin:0"><div id="chat" style="height:600px;overflow:auto"><div style="height:${ABOVE}px"></div>` +
    `<iframe sandbox="allow-scripts allow-forms" style="display:block;width:100%;border:0;height:${frameHeight}px" srcdoc="${escaped(frameDocument)}"></iframe>` +
    `<div style="height:2000px"></div></div><script>addEventListener("message",function(e){if(e.data==="acted")document.body.dataset.acted="1";});</script></body></html>`;

// The page's own document; `act` runs once it has loaded, and the page then tells the chat, so the test waits on that.
const pageOf = (body: string, act: string): string =>
    `<!doctype html><html><head></head><body>${body}<script>addEventListener("load",function(){setTimeout(function(){${act};parent.postMessage("acted","*");},50);});</script></body></html>`;
const inChat = (html: string): string => sizedFirst(sealedPage(html, PAGE_FALLBACK_THEMES.dark));
const published = (html: string): string => publishedPage(standalonePage(html));

describe.skipIf(!chromium.runs)(chromium.title("a page's scripted scrolling stays inside its frame"), () => {
    let browser: Browser;
    beforeAll(async () => {
        browser = await playwright!.chromium.launch({ headless: true, executablePath: playwright!.chromium.executablePath() });
    });
    afterAll(async () => {
        await browser?.close();
    });

    const open = async (frameDocument: string, frameHeight = 3400): Promise<{ page: Page; frame: Frame; chat: () => Promise<number> }> => {
        const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
        await page.setContent(chatAround(frameDocument, frameHeight));
        const frame = await (await page.waitForSelector(`iframe`)).contentFrame();
        if (frame === null) {
            throw new Error(`the page's frame never opened`);
        }
        return { page, frame, chat: () => page.evaluate(() => document.getElementById(`chat`)!.scrollTop) };
    };
    const acted = async (page: Page): Promise<void> => {
        await page.waitForFunction(() => document.body.dataset[`acted`] === `1`, undefined, { timeout: 10_000 });
    };

    it.each([
        [`in the chat`, inChat],
        [`in a published conversation`, published],
    ])("leaves the chat where it was when a page scrolls into view and focuses as it loads, %s", async (_where, frameOf) => {
        const { page, frame, chat } = await open(
            frameOf(
                pageOf(
                    TALL,
                    `document.getElementById("t").scrollIntoView();document.getElementById("t").scrollIntoView({block:"center",behavior:"smooth"});` +
                        `document.getElementById("t").scrollIntoViewIfNeeded();document.getElementById("x").focus()`,
                ),
            ),
        );
        await acted(page);
        expect(await chat()).toBe(0);
        // Focus still lands; only the scroll that came with it is kept in.
        expect(await frame.evaluate(() => document.activeElement?.id)).toBe(`x`);
        await page.close();
    }, 30_000);

    it("still scrolls a scroller inside the page to what it asked for", async () => {
        const { page, frame, chat } = await open(
            inChat(
                pageOf(
                    `<div id="box" style="height:100px;overflow:auto"><div style="height:600px"></div><div id="t">in the box</div><div style="height:600px"></div></div>`,
                    `document.getElementById("t").scrollIntoView({block:"start"})`,
                ),
            ),
        );
        await acted(page);
        expect(await frame.evaluate(() => document.getElementById(`box`)!.scrollTop)).toBe(600);
        expect(await chat()).toBe(0);
        await page.close();
    }, 30_000);

    it("scrolls a frame held shorter than its page within its own viewport", async () => {
        const { page, frame, chat } = await open(inChat(pageOf(TALL, `document.getElementById("t").scrollIntoView({block:"start"})`)), 400);
        await acted(page);
        expect(await frame.evaluate(() => Math.round(document.getElementById(`t`)!.getBoundingClientRect().top))).toBe(0);
        expect(await chat()).toBe(0);
        await page.close();
    }, 30_000);

    it("lets the browser's own scroll run right after the reader's press in the page", async () => {
        const { page, frame, chat } = await open(
            inChat(`<!doctype html><html><head></head><body><button id="go">go</button>${TALL}<script>document.getElementById("go").onclick=function(){document.getElementById("t").scrollIntoView()}</script></body></html>`),
        );
        await page.evaluate((top) => (document.getElementById(`chat`)!.scrollTop = top), ABOVE);
        await frame.click(`#go`);
        // The target is brought to the top of the chat, as the browser brings it.
        const targetInChat = async (): Promise<number> => {
            const frameTop = await page.evaluate(() => document.querySelector(`iframe`)!.getBoundingClientRect().top);
            return Math.round(frameTop + (await frame.evaluate(() => document.getElementById(`t`)!.getBoundingClientRect().top)));
        };
        await page.waitForFunction((from) => document.getElementById(`chat`)!.scrollTop !== from, ABOVE, { timeout: 10_000 });
        expect(await targetInChat()).toBe(0);
        expect(await chat()).toBeGreaterThan(ABOVE);
        await page.close();
    }, 30_000);
});
