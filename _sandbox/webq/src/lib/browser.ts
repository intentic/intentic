/* The JS-rendering fallback: the image's own Chromium, driven headless through playwright. Chromium is a
 * FEATURE PACK, not a base-image staple (packs/browser.Dockerfile), so availability is a runtime fact:
 * playwright's executablePath() DERIVES a path from its pinned revision and returns it whether or not the
 * pack put a browser there, and the existsSync gate below is what turns that claim into an answer — the
 * same gate browser-tools.ts uses for the agent's interactive browser. Absent, webq degrades to the static
 * HTML and says so in the capsule; it never downloads a browser mid-command.
 *
 * One browser per process, launched on first need: a crawl renders many pages through one Chromium, and a
 * fetch that never needs JS pays nothing. Images, media and fonts are aborted at the route layer — the
 * reader is a markdown converter, pixels are pure latency. */
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
    // executablePath stated explicitly: a bare headless launch reaches for the separate headless-shell
    // build, which the image deliberately does not carry (packs/browser.Dockerfile deletes it) — the full
    // browser under --headless is the one Chromium everything in the sandbox shares.
    browser ??= await chromium.launch({ executablePath: chromium.executablePath(), headless: true, args: ["--no-sandbox"] });
    const context = await browser.newContext({ javaScriptEnabled: true, viewport: { width: 1280, height: 900 } });
    try {
        await context.route("**/*", (route) => {
            const kind = route.request().resourceType();
            return kind === "image" || kind === "media" || kind === "font" ? route.abort() : route.continue();
        });
        const page = await context.newPage();
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        // Give hydration a moment, but never let a long-polling page hold the command hostage: network-idle
        // is a bonus with its own small deadline, not a requirement.
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
