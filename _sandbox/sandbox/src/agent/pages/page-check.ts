import { existsSync } from "node:fs";
import type { Browser } from "playwright";
import { PAGE_COLUMN_WIDTH, PAGE_FALLBACK_THEMES, type PageAppearance, sealedPage } from "@intentic/sandbox-contract";

// The agent's look at its own page before anyone else's: the page laid out in the sandbox's own headless Chromium,
// sealed and themed exactly as the chat's frame seals it, at the chat's column width. Answers with a picture, the height
// the page needs, and everything its scripts said or threw, so a blank chart is caught by the agent, not the reader.

const MIN_WIDTH = 240;
const MAX_WIDTH = 1600;
// The tallest stretch the picture shows; a longer page is measured whole and pictured from the top.
const MAX_CAPTURE = 1600;
// How long a page's scripts get after load before it is measured: enough for a chart's first animation frame.
const SETTLE_MS = 600;
const LOAD_TIMEOUT_MS = 15_000;
// A browser kept warm between checks, so iterating on a page costs a render rather than a launch each time.
const IDLE_CLOSE_MS = 90_000;
// Each check opens its own context; more at once mostly costs memory.
const MAX_AT_ONCE = 2;
// Lines a page's console may hand back; a page logging in a loop is cut, and says so.
const MAX_MESSAGES = 40;
const MAX_MESSAGE_CHARS = 600;

export interface PageMessage {
    readonly level: "log" | "info" | "warning" | "error";
    readonly text: string;
}

export interface PageCheck {
    // Base64 PNG of the top of the page.
    readonly png: string;
    readonly width: number;
    // What the page needs to show without scrolling, at this width.
    readonly contentHeight: number;
    readonly capturedHeight: number;
    readonly messages: readonly PageMessage[];
    // Uncaught exceptions, each with its stack's first line.
    readonly errors: readonly string[];
}

export type PageCheckResult = { readonly ok: true; readonly check: PageCheck } | { readonly ok: false; readonly reason: string };

let browser: Promise<Browser | undefined> | undefined;
let idle: ReturnType<typeof setTimeout> | undefined;
let running = 0;
const queue: (() => void)[] = [];

// One Chromium for every check, launched on the first and closed after a quiet spell; undefined where the image has none.
const browserOf = (): Promise<Browser | undefined> => {
    if (browser === undefined) {
        browser = (async () => {
            const { chromium } = await import("playwright").catch(() => ({ chromium: undefined }));
            if (chromium === undefined || !existsSync(chromium.executablePath())) {
                return undefined;
            }
            const launched = await chromium.launch({ headless: true, executablePath: chromium.executablePath() });
            launched.on("disconnected", () => {
                browser = undefined;
            });
            return launched;
        })().catch(() => {
            browser = undefined;
            return undefined;
        });
    }
    return browser;
};

const keepWarm = (): void => {
    if (idle !== undefined) {
        clearTimeout(idle);
    }
    idle = setTimeout(() => {
        idle = undefined;
        if (running > 0) {
            return;
        }
        const closing = browser;
        browser = undefined;
        void closing?.then((open) => open?.close()).catch(() => undefined);
    }, IDLE_CLOSE_MS);
    idle.unref?.();
};

const slot = async (): Promise<() => void> => {
    if (running >= MAX_AT_ONCE) {
        await new Promise<void>((resolve) => queue.push(resolve));
    }
    running += 1;
    return () => {
        running -= 1;
        queue.shift()?.();
        keepWarm();
    };
};

const clip = (text: string): string => (text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text);

const levelOf = (type: string): PageMessage["level"] | undefined => {
    switch (type) {
        case "log":
        case "debug":
            return "log";
        case "info":
            return "info";
        case "warning":
            return "warning";
        case "error":
            return "error";
        default:
            return undefined;
    }
};

// The page laid out and pictured, or why it could not be.
export const checkPage = async (html: string, options: { readonly width?: number; readonly appearance?: PageAppearance } = {}): Promise<PageCheckResult> => {
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(options.width ?? PAGE_COLUMN_WIDTH)));
    const appearance = options.appearance ?? "dark";
    const release = await slot();
    try {
        const open = await browserOf();
        if (open === undefined) {
            return { ok: false, reason: "this sandbox has no browser to check the page with, so it was shown unchecked" };
        }
        // Offline as well as sealed: a page reaching for the network is caught here as it would fail in the chat.
        const context = await open.newContext({ viewport: { width, height: 800 }, deviceScaleFactor: 1, colorScheme: appearance, offline: true });
        try {
            const page = await context.newPage();
            const messages: PageMessage[] = [];
            const errors: string[] = [];
            let dropped = 0;
            page.on("console", (message) => {
                const level = levelOf(message.type());
                if (level === undefined) {
                    return;
                }
                if (messages.length >= MAX_MESSAGES) {
                    dropped += 1;
                    return;
                }
                messages.push({ level, text: clip(message.text()) });
            });
            page.on("pageerror", (error) => {
                if (errors.length < MAX_MESSAGES) {
                    errors.push(clip(error.stack?.split("\n").slice(0, 2).join(" ") ?? error.message));
                }
            });
            await page.setContent(sealedPage(html, PAGE_FALLBACK_THEMES[appearance], { canvas: true }), {
                waitUntil: "load",
                timeout: LOAD_TIMEOUT_MS,
            });
            await page.waitForTimeout(SETTLE_MS);
            // The page's own box, not the viewport's: a short page laid out in a tall window is still short.
            const contentHeight = await page.evaluate(() => {
                const body = document.body;
                return Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, body === null ? 0 : body.getBoundingClientRect().bottom));
            });
            const capturedHeight = Math.max(1, Math.min(contentHeight, MAX_CAPTURE));
            const png = await page.screenshot({ type: "png", fullPage: true, clip: { x: 0, y: 0, width, height: capturedHeight } });
            if (dropped > 0) {
                messages.push({ level: "info", text: `(${dropped} more console messages not shown)` });
            }
            return { ok: true, check: { png: png.toString("base64"), width, contentHeight, capturedHeight, messages, errors } };
        } finally {
            await context.close().catch(() => undefined);
        }
    } catch (error) {
        return { ok: false, reason: `the check could not lay the page out (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
    } finally {
        release();
    }
};
