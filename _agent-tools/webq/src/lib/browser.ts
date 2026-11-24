// JS-rendering fallback via the image's own headless Chromium, a feature pack that may not be present; existsSync is
// what confirms it, not executablePath() alone. One browser per process; images, media and fonts are aborted since only
// markdown is read from the page.
import { existsSync } from "node:fs";
import type { Browser } from "playwright";

export interface RenderedPage {
    readonly finalUrl: string;
    readonly html: string;
}

let browser: Browser | undefined;

export const chromiumAvailable = async (): Promise<boolean> => {
    const { chromium } = await import("playwright");
    return existsSync(chromium.executablePath());
};

export const renderPage = async (url: string, timeoutMs: number): Promise<RenderedPage> => {
    const { chromium } = await import("playwright");
    // executablePath is explicit: a bare launch reaches for the headless-shell build, absent from this image.
    browser ??= await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ javaScriptEnabled: true, viewport: { width: 1280, height: 900 } });
    try {
        await context.route("**/*", (route) => {
            const kind = route.request().resourceType();
            return kind === "image" || kind === "media" || kind === "font" ? route.abort() : route.continue();
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        // Network-idle is a bonus with its own short deadline; a long-polling page must not hold the command hostage.
        await page.waitForLoadState("networkidle", { timeout: Math.min(5_000, timeoutMs) }).catch(() => undefined);
        return { finalUrl: page.url(), html: await page.content() };
    } finally {
        await context.close();
    }
};

export const closeBrowser = async (): Promise<void> => {
    await browser?.close();
    browser = undefined;
};
