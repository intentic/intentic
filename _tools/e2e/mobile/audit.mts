/* THE MOBILE GEOMETRY GATE — a phone-shaped browser walked over every mobile route, failing the build on the
 * three defects that a typecheck, a lint and a mounted-component test all pass straight through.
 *
 * WHY THIS EXISTS. The mobile shell was audited by hand and the findings were not subtle: the Files tab
 * rendered a blank screen because a directive-less `<template>` was passed through to the DOM as a real
 * `<template>` element (`display: none`, so every row had the data it needed and zero height); the upload FAB
 * laid out 18px off the LEFT edge because PrimeVue's `.p-button { position: relative }` beat the `absolute`
 * utility on it; the mobile menu's Pipelines row rendered its own name at zero width because a badge carrying a
 * SENTENCE was `shrink-0` beside it. Every one of those is invisible to the checks this repo already runs —
 * the components mount, the props are typed, the elements are in the tree. They are only visible as GEOMETRY.
 *
 * So the assertions are geometric, and there are three:
 *
 *   BLANK      A route whose primary list has no rendered height is a broken route. Catches the `<template>`
 *              class of bug, and anything else that puts content in the tree without putting it on screen.
 *   OFFSCREEN  Nothing may extend past the viewport unless an ancestor scrolls that axis. Catches the FAB, the
 *              badge, and every future `shrink-0` fighting a name for a 390px row.
 *   TARGETS    No interactive element below the floor. WCAG 2.2 SC 2.5.8 asks 24×24 and that is what FAILS
 *              here; 44 is the goal and is reported as a warning, because reaching it everywhere is a design
 *              conversation per surface and a gate that fails on it would be turned off in a week.
 *
 * HERMETIC, like the shots harness next door and for the same reason: it drives the demo build of the real SPA
 * (`_site/demo`, which enters the app's own source with a recorded fixture in place of a daemon), so there is no
 * postgres, no platform API and no seeded session between a CI job and an answer. That is what makes it cheap
 * enough to run on every merge request, which is the only way a geometry rule survives.
 *
 *   pnpm --filter @intentic-dev/demo build
 *   node --experimental-strip-types _tools/e2e/mobile/audit.mts
 *   node --experimental-strip-types _tools/e2e/mobile/audit.mts --json      # machine-readable, for CI
 *
 * A TOUCH CONTEXT, NOT JUST A NARROW ONE. `isMobile` + `hasTouch` is what makes `(pointer: coarse)` match, and
 * that media query is where the `touch-target` utility lives — so a run in a merely-resized desktop browser
 * measures the mouse's hit areas and reports failures that do not exist on a phone. This is the one setting
 * the whole file depends on being right.
 */
import { createReadStream, existsSync, mkdirSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { chromium, type Browser } from "@playwright/test";

const DEMO_DIR = join(repoRoot(import.meta.url), "_site/site/public/demo");
/* Its own port, one above the shots harness's. Sharing one would make a screenshot run and an audit run
 * mutually exclusive, and CI has no reason to serialize them. */
const PORT = 47_148;
const ORIGIN = `http://localhost:${PORT}`;
const BASE = "/demo";

/* 390×844 — an iPhone 14/15's logical viewport, and the NARROWEST mainstream phone worth gating on. The shots
 * harness uses 430×932 (a Pro Max) because a marketing picture wants the roomiest honest frame; a gate wants
 * the tightest one, since every overflow and every squeezed label appears here first. */
const VIEWPORT = { width: 390, height: 844 };

/* WCAG 2.2 SC 2.5.8 (AA). Below this is a failure. */
const FAIL_PX = 24;
/* Apple HIG / Material. Below this is reported and does not fail — see the header. */
const WARN_PX = 44;

interface Surface {
    readonly path: string;
    /** Text or selector the route is not itself until it renders — the same idea as the shots harness's. */
    readonly waitFor?: string;
    /* A SELECTOR WHOSE FIRST MATCH MUST HAVE HEIGHT. This is the blank-screen assertion, and it is per-route
     * because only the route knows what its own primary content is: the workspace's is a file row, the fleet's
     * is an agent card. Omitted for a surface whose honest state in the recording is empty. */
    readonly primary?: string;
    /* Controls to press before measuring — for a panel whose content is behind a switch (the workspace's
     * Changes tab is a different set of rows from its Files tab, and both need gating). */
    readonly click?: readonly string[];
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
    /* EVERY SURFACE ANCHORS ON SOMETHING IT RENDERS. These four ran on `settleMs` alone, and a fixed wait is
     * not a wait for the page — on a cold runner (a CI job that has just fetched the browser, which is exactly
     * when this gate runs) their views had not mounted at 1.2–1.6s, so all three assertions measured an EMPTY
     * document and reported "0 targets, clean". A gate that passes hardest when the page fails to render is
     * worse than no gate on those routes, because the row still says ✓. Warm, they measure 16 / 20 / 19 / 11.
     * `waitFor` holds until the view is actually there and `primary` fails the run if what the reader came for
     * has no height — the same pair every surface above already carries. */
    { path: "/settings", waitFor: "text=Keybindings", primary: "text=Display name", settleMs: 1_200 },
    // The accessory key row, which is the whole reason this route is gated: it is `coarse`-only, so a run that
    // is not in a touch context finds nothing here and says so instead of passing quietly.
    { path: "/terminal", waitFor: "text=Esc", primary: "text=Ctrl", settleMs: 1_600 },
    { path: "/agents/cnv_checkout_stripe", waitFor: 'textarea[name="draft"]', settleMs: 2_600 },
    { path: "/ext/pipelines", waitFor: "text=pass rate", primary: "text=Draft the release note", settleMs: 1_600 },
    { path: "/ext/acceptance", waitFor: "text=criteria", primary: "text=Sign up for an account", settleMs: 1_400 },
    /* `primary` matches raw `textContent`, not rendered text, so it must not name anything CSS uppercases —
     * this view's group headings ("The storefront") are drawn in caps and read as caps on screen, and an
     * anchor copied off the screen matched nothing and reported the page blank. A path is safe: nothing
     * transforms it, and it is the row the reader actually came for. */
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

interface Measured {
    readonly targets: number;
    readonly failures: readonly Offender[];
    readonly warnings: readonly Offender[];
    readonly overflow: readonly Overflow[];
    readonly primaryHeight: number | null;
}

/* Everything measured in ONE page evaluation, so the three assertions see the identical layout. Split across
 * three round trips they would not: the fleet board streams a turn, and a card that arrives between two
 * measurements is a discrepancy nobody can reproduce. */
/* oxlint-disable unicorn/consistent-function-scoping -- every helper below is defined INSIDE the evaluate
 * callback because that callback is serialized and run in the BROWSER's realm. Hoisting one to this module's
 * scope would leave it in Node, where the page cannot reach it, and the run would fail at the first call. The
 * rule cannot see the realm boundary; this comment is the boundary. */
const measure = async (page: import("@playwright/test").Page, primary: string | undefined): Promise<Measured> => {
    return page.evaluate(
        ({ failPx, warnPx, primarySelector }) => {
            /* THE TAP RECTANGLE, WHICH IS NOT ALWAYS THE DRAWN ONE. `touch-target` grows the hit area with an
             * `::after` overlay and deliberately leaves the box alone, so measuring the box would report a
             * failure the finger never meets. The overlay's own rect is what a tap lands on, so where one
             * exists it is the answer, and the drawn box is the answer everywhere else. */
            const tapRect = (el: Element): { width: number; height: number } => {
                const box = el.getBoundingClientRect();
                const overlay = getComputedStyle(el, "::after");
                if (overlay.content === "none" || overlay.position !== "absolute") {
                    return { width: box.width, height: box.height };
                }
                /* BOTH `height` AND `min-height` COUNT, on each axis. The shared utility states its floor as a
                 * minimum over a 100% box; the effort meter's one-axis version states a height outright. Both
                 * are the overlay saying how big the tap is, so the answer is the largest of the three numbers
                 * — reading only the minimum reported the meter as 19px tall when it is 44. */
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
                /* THE INLINE EXCEPTION, verbatim from WCAG 2.2 SC 2.5.8: a target "in a sentence, or whose size
                 * is otherwise constrained by the line-height of non-target text" is exempt. It has to be
                 * honoured or this gate is noise — the first run reported a sandbox URL at 212×18, a repository
                 * name at 115×18 and every pipeline title, all of which are text set in running copy and none of
                 * which can be made 24px tall without setting the prose that surrounds them 24px tall too.
                 *
                 * `display: inline` IS the discriminator, and a precise one: a link flowing in a sentence
                 * computes to it, while everything this gate is actually for — a pill, an icon button, a tab, a
                 * segmented option — is `flex` or `inline-flex` because it centres its own contents. So the
                 * exemption cannot quietly cover a control that merely happens to be short. */
                if (style.display === "inline") {
                    continue;
                }
                targets += 1;
                const tap = tapRect(el);
                const offender = { label: name(el), w: Math.round(tap.width), h: Math.round(tap.height) };
                /* THE SHORTER SIDE DECIDES. A 176×22 control is not hard to hit along its length — the axis a
                 * finger misses on is the narrow one, and a rule reading `width < 24 || height < 24` fails a
                 * full-width 22px row for its width, which is not the defect. The smaller dimension is what
                 * SC 2.5.8 is about, and it is what makes the difference between this list being read and
                 * being switched off. */
                const smaller = Math.min(tap.width, tap.height);
                if (smaller < failPx) {
                    failures.push(offender);
                } else if (smaller < warnPx) {
                    warnings.push(offender);
                }
            }

            /* PAST THE RIGHT EDGE, AND NOT INSIDE ANYTHING THAT SCROLLS THERE. A horizontally scrollable strip
             * (the hub sub-navs) legitimately extends past the fold; a name squeezed to zero by a `shrink-0`
             * badge does not, and the difference is entirely whether an ancestor can be scrolled to reach it. */
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

            /* THE BLANK-SCREEN ASSERTION: is the thing a person came to read drawn at a readable height.
             *
             * Matched by scanning for the text rather than through a selector engine, because the defect this
             * exists for puts the element in the tree with the right text and NO HEIGHT — so the question is
             * never "is it there", it is "how tall is it". The DEEPEST element carrying the text is the one
             * measured: an ancestor always has height (the panel does, the page does), and measuring one of
             * those is how a blank list reports as fine. */
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

            return { targets, failures, warnings, overflow, primaryHeight };
        },
        { failPx: FAIL_PX, warnPx: WARN_PX, primarySelector: primary },
    );
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

const audit = async (browser: Browser, surface: Surface): Promise<Result> => {
    // isMobile + hasTouch is what makes `(pointer: coarse)` match — see the header. Without it every
    // touch-target overlay is inert and this whole run measures the wrong rectangles.
    const context = await browser.newContext({ viewport: VIEWPORT, isMobile: true, hasTouch: true, colorScheme: "dark" });
    const page = await context.newPage();
    const empty: Measured = { targets: 0, failures: [], warnings: [], overflow: [], primaryHeight: null };
    try {
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
        const measured = await measure(page, surface.primary);
        return { path: surface.path, ...measured, blank: surface.primary !== undefined && (measured.primaryHeight ?? 0) === 0 };
    } catch (error) {
        return { path: surface.path, ...empty, blank: false, error: (error as Error).message.split("\n")[0] };
    } finally {
        await page.close();
        await context.close();
    }
};

const run = async (): Promise<void> => {
    const asJson = process.argv.includes("--json");
    if (!existsSync(join(DEMO_DIR, "index.html"))) {
        throw new Error(`No demo build at ${DEMO_DIR} — run: pnpm --filter @intentic-dev/demo build`);
    }
    mkdirSync(DEMO_DIR, { recursive: true });
    const server = serveDemo();
    const browser = await chromium.launch();
    const results: Result[] = [];
    try {
        for (const surface of SURFACES) {
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
            ].filter((flag) => flag !== ``);
            const mark = flags.length === 0 ? `✓` : `✗`;
            console.log(`${mark} ${result.path.padEnd(34)} ${result.targets} targets  ${flags.join(`, `) || `clean`}`);
            for (const offender of result.failures) {
                console.log(`    under ${FAIL_PX}px: ${offender.label} — ${offender.w}×${offender.h}`);
            }
            for (const over of result.overflow.slice(0, 4)) {
                console.log(`    off-screen: ${over.label} — right edge ${over.right} of ${VIEWPORT.width}`);
            }
            if (result.warnings.length > 0) {
                console.log(`    (${result.warnings.length} under ${WARN_PX}px — reported, not failing)`);
            }
        }
    }

    const broken = results.filter((result) => result.error !== undefined || result.blank || result.overflow.length > 0 || result.failures.length > 0);
    if (broken.length > 0) {
        console.error(`\n${broken.length} of ${results.length} mobile surfaces failed: ${broken.map((result) => result.path).join(`, `)}`);
        process.exitCode = 1;
        return;
    }
    console.log(`\nAll ${results.length} mobile surfaces clean.`);
};

await run();
