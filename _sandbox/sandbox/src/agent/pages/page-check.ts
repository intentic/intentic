import { existsSync } from "node:fs";
import type { Browser, Page } from "playwright";
import {
    PAGE_BRIDGE,
    PAGE_COLUMN_WIDTH,
    PAGE_FALLBACK_THEMES,
    PAGE_MAX_HEIGHT,
    type PageAppearance,
    type PageTheme,
    sealedPage,
    sizedFirst,
} from "@intentic/sandbox-contract";

// The agent's look at its own page before anyone else's: the page laid out in the sandbox's own headless Chromium the
// way the chat draws it, sealed and themed, inside a sandboxed frame across a column of the chat's width, written in
// through the same shell, and grown to whatever height the page's own bridge reports. A page laid out on its own would
// miss what only a frame does to it (it learns its width late, its height comes from what it reports, 100vh is the
// frame's), which is how a chart that drew blank for the reader once passed this check. Answers with a picture, the
// height the page needs, and everything its scripts said or threw, so a blank chart is caught by the agent, not the
// reader.

const MIN_WIDTH = 240;
const MAX_WIDTH = 1600;
// The tallest stretch the picture shows; a longer page is measured whole and pictured from the top.
const MAX_CAPTURE = 1600;
// How long a page's scripts get after load before it is measured: enough for a chart's first animation frame.
const SETTLE_MS = 600;
// The frame's height before the page says its own, as the chat's frame holds it (ChatPageFrame's placeholder).
const PLACEHOLDER = 200;
// How much taller the frame is made to see whether the page's height follows it rather than its content.
const PROBE_PX = 240;
const PROBE_MS = 250;
const LOAD_TIMEOUT_MS = 15_000;
// How long the page gets to say its height: a page with none to say (a blank chart) says nothing, and is measured.
const HEIGHT_WAIT_MS = 3_000;
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
    // The page's height followed its frame's rather than its content's (100vh, or height:100% on html or body).
    readonly followsFrame: boolean;
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
        // allow(silent-catch): an idle browser that fails to close is already gone or going; nothing waits on it.
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

// What the frame reports, kept on the host page for the check to read: the height the page last said, and what it threw.
interface Reported {
    readonly height: number;
    readonly errors: readonly string[];
}
declare global {
    interface Window {
        __page?: Reported;
    }
}

// The chat around the page: the conversation's background, and one sandboxed frame across the column, in the theme's
// own colour scheme (a frame whose scheme differs from its page's is painted opaque), sized as ChatPageFrame sizes it.
const hostDocument = (page: string, theme: PageTheme, cap: number): string =>
    `<!DOCTYPE html><html><head><style>html{color-scheme:${theme.appearance};background:${theme.variables["--background"]}}body{margin:0}` +
    `iframe{display:block;width:100%;height:${PLACEHOLDER}px;border:0;color-scheme:${theme.appearance}}</style>` +
    `<script>window.__page={height:0,errors:[]};addEventListener("message",function(e){var f=document.querySelector("iframe"),d=e.data;` +
    `if(!f||e.source!==f.contentWindow||!d||d.jsonrpc!=="2.0"||!d.params)return;` +
    `if(d.method===${JSON.stringify(PAGE_BRIDGE.sizeChanged)}&&d.params.height>0){var h=Math.ceil(d.params.height);` +
    `window.__page={height:h,errors:window.__page.errors};f.style.height=Math.min(${cap},Math.max(32,h))+"px";}` +
    `else if(d.method===${JSON.stringify(PAGE_BRIDGE.error)}&&typeof d.params.message==="string")window.__page.errors.push(d.params.message);});</script>` +
    `</head><body><iframe sandbox="allow-scripts allow-forms" srcdoc="${page.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"></iframe></body></html>`;

const reportedOf = (page: Page): Promise<Reported> => page.evaluate(() => window.__page ?? { height: 0, errors: [] });

// The page's own box inside its frame, not the frame's: a short page in a tall frame is still short.
const measuredInFrame = async (page: Page): Promise<number> => {
    const inner = page.frames().find((frame) => frame !== page.mainFrame());
    if (inner === undefined) {
        return 0;
    }
    return inner
        .evaluate(() => {
            const body = document.body;
            return Math.ceil(Math.max(document.documentElement.getBoundingClientRect().height, body === null ? 0 : body.getBoundingClientRect().bottom));
        })
        // allow(silent-catch): a frame that cannot be read measures as nothing, which the tool's note then says.
        .catch(() => 0);
};

// The page laid out and pictured, or why it could not be. `cap` is the tallest the agent let the frame grow.
export const checkPage = async (
    html: string,
    options: { readonly width?: number; readonly appearance?: PageAppearance; readonly cap?: number | undefined } = {},
): Promise<PageCheckResult> => {
    const width = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(options.width ?? PAGE_COLUMN_WIDTH)));
    const appearance = options.appearance ?? "dark";
    const theme = PAGE_FALLBACK_THEMES[appearance];
    const cap = Math.min(PAGE_MAX_HEIGHT, Math.max(32, Math.round(options.cap ?? PAGE_MAX_HEIGHT)));
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
            await page.setContent(hostDocument(sizedFirst(sealedPage(html, theme)), theme, cap), { waitUntil: "load", timeout: LOAD_TIMEOUT_MS });
            // The page's first word on its height, then its scripts' settling time, as the chat gives it.
            await page
                .waitForFunction(() => (window.__page?.height ?? 0) > 0, undefined, { timeout: HEIGHT_WAIT_MS })
                // allow(silent-catch): a page that never says its height is measured in its frame below instead.
                .catch(() => undefined);
            await page.waitForTimeout(SETTLE_MS);
            const settled = await reportedOf(page);
            // A page that never said its height is measured in its frame directly.
            const contentHeight = settled.height > 0 ? settled.height : await measuredInFrame(page);
            // Made taller for a moment: a page whose height follows its frame's grows with it, and the chat cannot fit it.
            const frame = page.locator("iframe");
            const held = Math.min(cap, Math.max(32, contentHeight));
            await frame.evaluate((element, px) => ((element as HTMLElement).style.height = `${px}px`), held + PROBE_PX);
            await page.waitForTimeout(PROBE_MS);
            const followsFrame = (await reportedOf(page)).height >= contentHeight + PROBE_PX - 8;
            await frame.evaluate((element, px) => ((element as HTMLElement).style.height = `${px}px`), held);
            await page.waitForTimeout(PROBE_MS);
            const capturedHeight = Math.max(1, Math.min(held, MAX_CAPTURE));
            const png = await page.screenshot({ type: "png", fullPage: true, clip: { x: 0, y: 0, width, height: capturedHeight } });
            // What the page's own bridge caught, beside what the browser saw thrown; each said once.
            for (const error of (await reportedOf(page)).errors) {
                if (!errors.includes(error) && errors.length < MAX_MESSAGES) {
                    errors.push(clip(error));
                }
            }
            if (dropped > 0) {
                messages.push({ level: "info", text: `(${dropped} more console messages not shown)` });
            }
            return { ok: true, check: { png: png.toString("base64"), width, contentHeight, capturedHeight, followsFrame, messages, errors } };
        } finally {
            // allow(silent-catch): the check has its answer; a context that fails to close dies with the browser.
            await context.close().catch(() => undefined);
        }
    } catch (error) {
        return { ok: false, reason: `the check could not lay the page out (${error instanceof Error ? error.message.split("\n")[0] : String(error)})` };
    } finally {
        release();
    }
};
