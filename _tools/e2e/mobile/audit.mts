/* Mobile geometry gate for route rendering, target sizes, horizontal overflow, and whether every scroller moves under a finger. */
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { chromium, type Browser, type CDPSession, type Page } from "@playwright/test";

const DEMO_DIR = join(repoRoot(import.meta.url), "_site/site/public/demo");
/* Its own port, one above the shots harness's. */
const PORT = 47_148;
const ORIGIN = `http://localhost:${PORT}`;
const BASE = "/demo";

/* The gate uses the narrowest supported phone viewport so overflow appears first. */
const VIEWPORT = { width: 390, height: 844 };

/* WCAG 2.2 SC 2.5.8 (AA). Below this is a failure. */
const FAIL_PX = 24;
/* Apple HIG / Material. Below this is reported and does not fail — see the header. */
const WARN_PX = 44;

interface Surface {
    readonly path: string;
    /** Text or selector the route is not itself until it renders — the same idea as the shots harness's. */
    readonly waitFor?: string;
    /* The primary selector identifies the route content that must have height. */
    readonly primary?: string;
    /* Click these controls before measuring content hidden behind a switch. */
    readonly click?: readonly string[];
    /* Tap this after measuring: it opens a bottom sheet, whose scrollers are then swiped like the page's own. */
    readonly sheet?: string;
    readonly settleMs?: number;
}

const SURFACES: readonly Surface[] = [
    { path: "/agents", waitFor: "text=ATTENTION", primary: "text=Add Stripe checkout", settleMs: 1_400 },
    // The one route whose blank screen shipped. `primary` is a file row, which is the whole point.
    { path: "/workspace", waitFor: 'button:has-text("Changes")', primary: "text=README.md", settleMs: 1_600 },
    {
        path: "/workspace?panel=changes",
        waitFor: 'button:has-text("Changes")',
        primary: "text=CheckoutPanel.tsx",
        settleMs: 1_600,
    },
    { path: "/menu", waitFor: "text=SANDBOXES", primary: "text=Add sandbox", settleMs: 1_200 },
    { path: "/capabilities", waitFor: "text=Connected", settleMs: 1_200 },
    { path: "/sandbox", waitFor: "text=Installed version", settleMs: 1_200 },
    /* Each route waits for rendered content before measuring its primary surface. */
    { path: "/settings", waitFor: "text=Keybindings", primary: "text=Profile", settleMs: 1_200 },
    // The accessory key row, which is the whole reason this route is gated: it is `coarse`-only, so a run that
    // is not in a touch context finds nothing here and says so instead of passing quietly.
    { path: "/terminal", waitFor: "text=Esc", primary: "text=Ctrl", settleMs: 1_600 },
    // The paperclip is the phone's one road for a photo, so the surface waits on it rather than on the box alone.
    // `primary` is visible transcript text: the paperclip has only an aria-label, which the height rule never reads.
    { path: "/agents/cnv_checkout_stripe", waitFor: 'button[aria-label="Attach files"]', primary: "text=The pricing page already has a CTA", settleMs: 2_600 },
    // The Chat tab: lands on the active conversation's screen, never on the desktop's full-screen chat. Its model
    // picker is the sheet that once did not scroll under touch at all, so the gate swipes it.
    {
        path: "/chat",
        waitFor: 'textarea[name="draft"]',
        primary: "text=Add Stripe checkout",
        sheet: 'button[aria-label^="Provider and model"]',
        settleMs: 2_600,
    },
    { path: "/ext/pipelines", waitFor: "text=pass rate", primary: "text=Draft the release note", settleMs: 1_600 },
    { path: "/ext/acceptance", waitFor: "text=criteria", primary: "text=Sign up for an account", settleMs: 1_400 },
    /* Primary selectors match raw textContent, so they must use text unaffected by CSS transforms. */
    { path: "/ext/documentation", waitFor: "text=documented", primary: "text=src/pricing", settleMs: 1_400 },
];

interface Offender {
    readonly label: string;
    readonly w: number;
    readonly h: number;
}

interface Overflow {
    readonly label: string;
    readonly right: number;
}

interface Stuck {
    readonly label: string;
    readonly axis: "x" | "y";
    readonly max: number;
}

interface Measured {
    readonly targets: number;
    readonly failures: readonly Offender[];
    readonly warnings: readonly Offender[];
    readonly overflow: readonly Overflow[];
    readonly primaryHeight: number | null;
    /* Scrollers that did not move under a synthesized finger; see `sweepScrollers`. */
    readonly stuck: readonly Stuck[];
}

/* Measure all geometry in one browser evaluation so every assertion sees one layout. */
/* oxlint-disable unicorn/consistent-function-scoping -- evaluate helpers must remain in the browser realm. */
const measure = async (page: import("@playwright/test").Page, primary: string | undefined): Promise<Measured> => {
    return page.evaluate(
        ({ failPx, warnPx, primarySelector }) => {
            /* Measure the touch overlay when it expands the drawn element's hit area. */
            const tapRect = (el: Element): { width: number; height: number } => {
                const box = el.getBoundingClientRect();
                const overlay = getComputedStyle(el, "::after");
                if (overlay.content === "none" || overlay.position !== "absolute") {
                    return { width: box.width, height: box.height };
                }
                /* Use the largest declared or drawn dimension because overlays may set height or minimum height. */
                const grow = (drawn: number, ...declared: string[]): number =>
                    Math.max(drawn, ...declared.map((value) => Number.parseFloat(value)).filter((value) => Number.isFinite(value)));
                return {
                    width: grow(box.width, overlay.width, overlay.minWidth),
                    height: grow(box.height, overlay.height, overlay.minHeight),
                };
            };

            const name = (el: Element): string => {
                const label = el.getAttribute("aria-label") ?? el.getAttribute("title") ?? (el as HTMLElement).innerText ?? "";
                return label.trim().replace(/\s+/g, " ").slice(0, 44) || `<${el.tagName.toLowerCase()}>`;
            };

            const failures: Offender[] = [];
            const warnings: Offender[] = [];
            let targets = 0;
            const interactive = document.querySelectorAll('button, a, input, select, textarea, [role="button"], [role="tab"]');
            for (const el of interactive) {
                const box = el.getBoundingClientRect();
                // A zero-size element is hidden, not undersized — a collapsed panel's buttons are not defects.
                if (box.width === 0 || box.height === 0) {
                    continue;
                }
                const style = getComputedStyle(el);
                // `type=hidden` inputs, the workspace's hidden file picker, and xterm's off-screen
                // screen-reader textarea all have a box and no presence. None of them is ever tapped.
                if (style.visibility === "hidden" || Number.parseFloat(style.opacity) === 0) {
                    continue;
                }
                /* Inline controls are exempt because their size is constrained by surrounding text. */
                if (style.display === "inline") {
                    continue;
                }
                targets += 1;
                const tap = tapRect(el);
                const offender = { label: name(el), w: Math.round(tap.width), h: Math.round(tap.height) };
                /* Compare the shorter side because the narrow axis determines target accessibility. */
                const smaller = Math.min(tap.width, tap.height);
                if (smaller < failPx) {
                    failures.push(offender);
                } else if (smaller < warnPx) {
                    warnings.push(offender);
                }
            }

            /* Report right-edge overflow unless an ancestor provides horizontal scrolling. */
            const overflow: Overflow[] = [];
            for (const el of document.querySelectorAll("main *")) {
                const box = el.getBoundingClientRect();
                if (box.width === 0 || box.right <= window.innerWidth + 1) {
                    continue;
                }
                let ancestor = el.parentElement;
                let scrolls = false;
                while (ancestor !== null) {
                    const overflowX = getComputedStyle(ancestor).overflowX;
                    if (overflowX === "auto" || overflowX === "scroll") {
                        scrolls = true;
                        break;
                    }
                    ancestor = ancestor.parentElement;
                }
                if (!scrolls) {
                    overflow.push({ label: name(el), right: Math.round(box.right) });
                }
            }

            /* Measure the deepest matching element so an empty child cannot inherit an ancestor's height. */
            let primaryHeight: number | null = null;
            if (primarySelector !== undefined) {
                const wanted = primarySelector.startsWith("text=") ? primarySelector.slice(5) : primarySelector;
                let deepest: Element | undefined;
                let depth = -1;
                for (const el of document.querySelectorAll("main *")) {
                    if ((el.textContent ?? "").includes(wanted)) {
                        let own = 0;
                        for (let node: Element | null = el; node !== null; node = node.parentElement) {
                            own += 1;
                        }
                        if (own > depth) {
                            depth = own;
                            deepest = el;
                        }
                    }
                }
                primaryHeight = deepest === undefined ? 0 : Math.round(deepest.getBoundingClientRect().height);
            }

            return { targets, failures, warnings, overflow, primaryHeight, stuck: [] };
        },
        { failPx: FAIL_PX, warnPx: WARN_PX, primarySelector: primary },
    );
};

/* A finger, not a wheel: touchStart, a run of touchMoves, touchEnd. `dy` negative moves the finger up, so the content
   scrolls down. Slow enough (500ms) to read as a drag on the gesture detector rather than a fling or a tap. */
const swipe = async (page: Page, cdp: CDPSession, x: number, y: number, dx: number, dy: number): Promise<void> => {
    const steps = 20;
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
    for (let i = 1; i <= steps; i += 1) {
        await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: x + (dx * i) / steps, y: y + (dy * i) / steps }] });
        await page.waitForTimeout(25);
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(600);
};

interface Scroller {
    readonly label: string;
    readonly axes: readonly ("x" | "y")[];
}

/* Every on-screen element with room to scroll on either axis, marked so the swipe can read it back by index. `scope`
   narrows the sweep to an open sheet. Markers from an earlier pass are cleared first: a teleported sheet sits after the
   page in the DOM, and a stale index would read the page's scroller in its place. */
const findScrollers = (page: Page, scope: string | undefined): Promise<Scroller[]> =>
    page.evaluate((scopeSelector) => {
        /* The axes an element has room to scroll on, by its own overflow, not an ancestor's. */
        const axesOf = (el: Element): ("x" | "y")[] => {
            const style = getComputedStyle(el);
            const axes: ("x" | "y")[] = [];
            if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight + 2) {
                axes.push("y");
            }
            if (/(auto|scroll)/.test(style.overflowX) && el.scrollWidth > el.clientWidth + 2) {
                axes.push("x");
            }
            return axes;
        };
        /* A finger needs a box to land on; slivers and off-screen scrollers are not the phone's to move. */
        const landable = (box: DOMRect): boolean => box.width >= 40 && box.height >= 40 && box.bottom >= 40 && box.top <= innerHeight - 40;

        for (const stale of document.querySelectorAll("[data-mobile-scroller]")) {
            stale.removeAttribute("data-mobile-scroller");
        }
        const root = scopeSelector === undefined ? document : document.querySelector(scopeSelector);
        if (root === null) {
            return [];
        }
        const found: Scroller[] = [];
        for (const el of root.querySelectorAll("*")) {
            const axes = axesOf(el);
            const box = el.getBoundingClientRect();
            if (axes.length === 0 || !landable(box)) {
                continue;
            }
            el.setAttribute("data-mobile-scroller", String(found.length));
            found.push({ label: `<${el.tagName.toLowerCase()}> ${String(el.className).split(" ").slice(0, 3).join(".")}`, axes });
        }
        return found;
    }, scope);

interface ScrollState {
    readonly top: number;
    readonly left: number;
    readonly maxTop: number;
    readonly maxLeft: number;
    /* Where a finger lands NOW: an earlier swipe on an ancestor may have carried this element since it was listed. */
    readonly x: number;
    readonly y: number;
}

const scrollOf = (page: Page, index: number): Promise<ScrollState | null> =>
    page.evaluate((i) => {
        const el = document.querySelector(`[data-mobile-scroller="${i}"]`);
        if (el === null) {
            return null;
        }
        const box = el.getBoundingClientRect();
        const top = Math.max(0, box.top);
        const bottom = Math.min(innerHeight, box.bottom);
        return {
            top: el.scrollTop,
            left: el.scrollLeft,
            maxTop: el.scrollHeight - el.clientHeight,
            maxLeft: el.scrollWidth - el.clientWidth,
            x: Math.round(box.left + box.width / 2),
            y: Math.round((top + bottom) / 2),
        };
    }, index);

/* Puts a swiped scroller back where it was listed, so the elements after it are still where they were measured. */
const restore = (page: Page, index: number, state: ScrollState): Promise<void> =>
    page.evaluate(
        ([i, top, left]) => {
            const el = document.querySelector(`[data-mobile-scroller="${i}"]`);
            if (el !== null) {
                el.scrollTop = top;
                el.scrollLeft = left;
            }
        },
        [index, state.top, state.left] as const,
    );

/* Swipes every scroller on the axis it claims, towards whichever end has room, and reports the ones that stayed put.
   This is the assertion the geometry above cannot make: a scroller can be the right size and still be dead under a
   finger (a contained non-scrolling ancestor, a graph claiming the touch). */
const sweepScrollers = async (page: Page, cdp: CDPSession, scope: string | undefined): Promise<Stuck[]> => {
    const stuck: Stuck[] = [];
    const scrollers = await findScrollers(page, scope);
    for (const [index, scroller] of scrollers.entries()) {
        for (const axis of scroller.axes) {
            const before = await scrollOf(page, index);
            if (before === null) {
                continue;
            }
            const max = axis === "y" ? before.maxTop : before.maxLeft;
            const at = axis === "y" ? before.top : before.left;
            const towardsEnd = at < max / 2;
            const distance = towardsEnd ? -160 : 160;
            await swipe(page, cdp, before.x, before.y, axis === "x" ? distance : 0, axis === "y" ? distance : 0);
            const after = await scrollOf(page, index);
            const moved = after !== null && Math.abs((axis === "y" ? after.top : after.left) - at) > 4;
            if (!moved) {
                stuck.push({ label: scroller.label, axis, max });
            }
            await restore(page, index, before);
        }
    }
    return stuck;
};

const TYPES: Record<string, string> = {
    ".html": "text/html",
    ".js": "text/javascript",
    ".mjs": "text/javascript",
    ".css": "text/css",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".webp": "image/webp",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".wasm": "application/wasm",
    ".map": "application/json",
};

// The demo is a history-mode SPA under a base, so any unknown path is one of its routes, not a 404.
const serveDemo = (): Server => {
    const server = createServer((request, response) => {
        const path = new URL(request.url ?? "/", ORIGIN).pathname;
        const routed = path.startsWith(`${BASE}/`) ? path.slice(BASE.length) : path;
        const asset = join(DEMO_DIR, normalize(decodeURIComponent(routed)));
        const file = existsSync(asset) && statSync(asset).isFile() ? asset : join(DEMO_DIR, "index.html");
        response.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store" });
        createReadStream(file).pipe(response);
    });
    server.listen(PORT, "localhost");
    return server;
};

interface Result extends Measured {
    readonly path: string;
    readonly blank: boolean;
    readonly error?: string;
}

/* Brings the route to the state the surface describes: loaded, its demo chrome hidden, its anchor rendered, its switches pressed. */
const arrive = async (page: Page, surface: Surface): Promise<void> => {
    await page.goto(`${ORIGIN}${BASE}${surface.path}`, { waitUntil: "domcontentloaded" });
    // The demo's own switcher is a fixed bar across the bottom and is not the product — it would be
    // measured as an off-screen overflow and as three undersized tabs on every single route.
    await page.addStyleTag({ content: "#demo-switcher { display: none !important; }" });
    if (surface.waitFor !== undefined) {
        await page.waitForSelector(surface.waitFor, { timeout: 20_000 }).catch(() => undefined);
    }
    for (const target of surface.click ?? []) {
        await page.click(target, { timeout: 20_000 }).catch(() => undefined);
        await page.waitForTimeout(600);
    }
    await page.waitForTimeout(surface.settleMs ?? 1_000);
};

/* The page's scrollers, then the sheet's once opened; sheet entries are labelled so a dead one names its home. */
const sweepSurface = async (page: Page, cdp: CDPSession, surface: Surface): Promise<Stuck[]> => {
    const stuck = [...(await sweepScrollers(page, cdp, undefined))];
    if (surface.sheet !== undefined) {
        await page.tap(surface.sheet, { timeout: 20_000 }).catch(() => undefined);
        await page.waitForTimeout(1_300);
        stuck.push(...(await sweepScrollers(page, cdp, ".p-drawer")).map((entry) => ({ ...entry, label: `sheet ${entry.label}` })));
    }
    return stuck;
};

const audit = async (browser: Browser, surface: Surface): Promise<Result> => {
    // isMobile + hasTouch is what makes `(pointer: coarse)` match — see the header. Without it every
    // touch-target overlay is inert and this whole run measures the wrong rectangles.
    const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, colorScheme: "dark" });
    const page = await context.newPage();
    const empty: Measured = { targets: 0, failures: [], warnings: [], overflow: [], primaryHeight: null, stuck: [] };
    try {
        await arrive(page, surface);
        const measured = await measure(page, surface.primary);
        const stuck = await sweepSurface(page, await context.newCDPSession(page), surface);
        return { path: surface.path, ...measured, stuck, blank: surface.primary !== undefined && (measured.primaryHeight ?? 0) === 0 };
    } catch (error) {
        return { path: surface.path, ...empty, blank: false, error: (error as Error).message.split("\n")[0] };
    } finally {
        await page.close();
        await context.close();
    }
};

const run = async (): Promise<void> => {
    const asJson = process.argv.includes("--json");
    // `--only=/chat` runs one surface while iterating; the exit code still means what it means.
    const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length);
    const surfaces = only === undefined ? SURFACES : SURFACES.filter((surface) => surface.path === only);
    if (!existsSync(join(DEMO_DIR, "index.html"))) {
        throw new Error(`No demo build at ${DEMO_DIR} — run: pnpm --filter @intentic/demo build`);
    }
    mkdirSync(DEMO_DIR, { recursive: true });
    const server = serveDemo();
    // The full baked chromium rather than the headless shell; ../playwright.config.ts carries the reasoning.
    const browser = await chromium.launch({ channel: "chromium" });
    const results: Result[] = [];
    try {
        for (const surface of surfaces) {
            results.push(await audit(browser, surface));
        }
    } finally {
        await browser.close();
        server.close();
    }

    if (asJson) {
        console.log(JSON.stringify(results, null, 2));
    } else {
        console.log(`\nMobile geometry — ${VIEWPORT.width}×${VIEWPORT.height}, touch\n`);
        for (const result of results) {
            const flags = [
                result.error !== undefined ? `ERROR ${result.error}` : ``,
                result.blank ? `BLANK` : ``,
                result.overflow.length > 0 ? `${result.overflow.length} off-screen` : ``,
                result.failures.length > 0 ? `${result.failures.length} under ${FAIL_PX}px` : ``,
                result.stuck.length > 0 ? `${result.stuck.length} stuck under touch` : ``,
            ].filter((flag) => flag !== ``);
            const mark = flags.length === 0 ? `✓` : `✗`;
            console.log(`${mark} ${result.path.padEnd(34)} ${result.targets} targets  ${flags.join(`, `) || `clean`}`);
            for (const offender of result.failures) {
                console.log(`    under ${FAIL_PX}px: ${offender.label} — ${offender.w}×${offender.h}`);
            }
            for (const over of result.overflow.slice(0, 4)) {
                console.log(`    off-screen: ${over.label} — right edge ${over.right} of ${VIEWPORT.width}`);
            }
            for (const dead of result.stuck) {
                console.log(`    stuck under touch: ${dead.label} — ${dead.axis} axis, ${dead.max}px of room`);
            }
            if (result.warnings.length > 0) {
                console.log(`    (${result.warnings.length} under ${WARN_PX}px — reported, not failing)`);
            }
        }
    }

    const broken = results.filter(
        (result) => result.error !== undefined || result.blank || result.overflow.length > 0 || result.failures.length > 0 || result.stuck.length > 0,
    );
    if (broken.length > 0) {
        console.error(`\n${broken.length} of ${results.length} mobile surfaces failed: ${broken.map((result) => result.path).join(`, `)}`);
        process.exitCode = 1;
        return;
    }
    console.log(`\nAll ${results.length} mobile surfaces clean.`);
};

await run();
