#!/usr/bin/env node
/* IS THE MARK ACTUALLY LEVEL WITH THE WORDS? — measured in a real browser, on the real pages.
 *
 * This is the half of the mark-alignment gate that a static reader cannot do. `_tools/checks/mark-alignment.mjs`
 * keeps anybody from hand-placing a mark; only a layout engine can say whether the rule that places them lands
 * where it should, because the answer depends on the font's metrics, the row's leading and the size the page is
 * being drawn at. Nothing else in the repository can see this: a misaligned bullet type-checks, lints and passes
 * every unit test, and the only reader who has ever caught one is a person looking at a screenshot.
 *
 * WHAT IT ASSERTS, for every mark on every page below, at a wide viewport and a narrow one:
 *
 *   1. The mark is inside the primitive (`.mark`). A bare `.lotus` or `.lozenge` dropped straight into a text row
 *      may happen to look right today at the one type size it was placed against — that is exactly how the five
 *      constants this replaced were born.
 *   2. Its centre is within a pixel of the centre of the FIRST LINE of the text beside it. First line, not the
 *      row: a two-line point must keep its bullet on line one, which is the case `align-items: center` gets wrong
 *      and the case nobody screenshots.
 *
 * The one exclusion is `.lockup`, the wordmark, where the flower is deliberately aligned on the letters rather
 * than on the line box (global.css says why). It is excluded here and allowed by name in the static check, which
 * is the whole of the exception in both readers.
 *
 * NO GOLDEN IMAGES. A screenshot diff would fail on every copy edit and teach everyone to re-bless it; this
 * asserts the one geometric relation that has to hold, so it only ever fires on the bug it is named after.
 *
 * WHERE THERE IS NO BROWSER (a CI runner with no Playwright download, a fresh clone) it says so and vouches for
 * nothing, rather than failing for the tree's state. The turn that changes the site runs in a sandbox that has
 * one, which is the moment this needs to speak. */
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

/* The pages with marks on them: the landing page (every kind of row the site has), pricing (the lists this was
 * found on), about (the trust cards' heading marks) and a feature page (the docs-shaped layout). A route that
 * stops yielding marks ANYWHERE fails rather than passing quietly — that is how a check like this goes hollow.
 * Per viewport it is allowed to find none: below the bar's breakpoint the flyout's marks are not drawn at all.
 * Trailing slashes because that is the shape the site's own links have; the dev server 404s the other one. */
const ROUTES = ["/", "/pricing/", "/about/", "/features/review/"];
// Wide enough for the two-column layouts, and a phone: the offset is computed from leading, so it must hold at
// both, and the bar redraws its wordmark at a second size below 30rem.
const VIEWPORTS = [
    { label: "wide", width: 1280, height: 900 },
    { label: "narrow", width: 390, height: 844 },
];
// A mark's centre may differ from the line's centre by this much. Half a pixel is rounding; three is visible.
const TOLERANCE = 1;

/* THE MEASUREMENT, run inside the page. One self-contained function because it is serialised to the browser: it
 * can close over nothing from this file. */
const audit = () => {
    const MARK = ".mark, .lotus, .lozenge";

    const label = (element) => {
        const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
        const words = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 44);
        return `${element.tagName.toLowerCase()}${classes === "" ? "" : `.${classes}`} \u201c${words}\u201d`;
    };

    /* The row this mark has to line up inside, or null when it is not that kind of mark at all: a finial, the
     * knot in a divider, a mark on its own line, the drawing inside a wrapper already being measured, or the
     * wordmark lockup, which is aligned on the letters instead (global.css says why). */
    const rowFor = (mark) => {
        const wrapper = mark.closest(".mark");
        if ((wrapper !== null && wrapper !== mark) || mark.closest(".lockup") !== null) {
            return null;
        }
        const row = mark.parentElement;
        if (row === null) {
            return null;
        }
        const style = getComputedStyle(row);
        return style.display.includes("flex") && style.flexDirection === "row" ? row : null;
    };

    // The words this mark has to be level with: the first sibling in the row that carries any.
    const textBeside = (row, mark) => {
        for (const node of row.childNodes) {
            if (node === mark || node.textContent.trim() === "") {
                continue;
            }
            if (node.nodeType === Node.TEXT_NODE) {
                return row; // a bare text node's line box is the row's own
            }
            if (node.nodeType === Node.ELEMENT_NODE && !node.matches(MARK)) {
                return node;
            }
        }
        return null;
    };

    // How far the mark's centre is from the centre of the text's FIRST line box, which starts inside the border
    // and the padding and is `line-height` tall. Positive is below.
    const offset = (box, text) => {
        const style = getComputedStyle(text);
        const leading = Number.parseFloat(style.lineHeight);
        if (!Number.isFinite(leading)) {
            return { unmeasurable: true };
        }
        const rect = text.getBoundingClientRect();
        const firstLineTop = rect.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
        return { delta: Math.round((box.top + box.height / 2 - (firstLineTop + leading / 2)) * 100) / 100 };
    };

    const rows = [];
    for (const mark of document.querySelectorAll(MARK)) {
        const row = rowFor(mark);
        const text = row === null ? null : textBeside(row, mark);
        const box = mark.getBoundingClientRect();
        if (text === null || box.height === 0) {
            continue; // nothing to be level with, or not drawn at this width
        }
        rows.push({ where: label(row), wrapped: mark.classList.contains("mark"), ...offset(box, text) });
    }
    return rows;
};

// What each measured row has to say for itself, as the line a person would need to go and fix it.
const faults = (rows, route, viewport) =>
    rows.flatMap((row) => {
        const at = `${route} (${viewport.label}): ${row.where}`;
        if (row.unmeasurable === true) {
            return [`${at} \u2014 the text has no numeric line-height, so nothing can be measured against it`];
        }
        if (!row.wrapped) {
            return [`${at} \u2014 a bare mark in a text row: wrap it in <Bullet>, or use <Point> for a list row`];
        }
        if (Math.abs(row.delta) > TOLERANCE) {
            return [`${at} \u2014 the mark sits ${Math.abs(row.delta)}px ${row.delta > 0 ? "below" : "above"} the centre of its first line`];
        }
        return [];
    });

/* WHATEVER BROWSER THIS MACHINE HAS. Playwright's default is the headless shell, which is a separate download
 * from the full build, and a machine that has one and not the other is the ordinary case rather than a broken
 * install — so both are tried before this gives up. Asking `executablePath()` instead would be a second opinion
 * about a question only `launch()` answers: it names the default build whether or not that is the one that
 * would actually start. */
/* `undefined` where Playwright is not installed at all, which is a tree that has not been set up rather than a
 * tree that is wrong: the same reason the vue-template check attempts its compiler and vouches for less. */
const chromium = await import("playwright").then(
    (playwright) => playwright.chromium,
    () => undefined,
);
const open = async () => {
    if (chromium === undefined) {
        return null;
    }
    for (const options of [{}, { channel: "chromium" }]) {
        try {
            return await chromium.launch(options);
        } catch (error) {
            if (!/Executable doesn't exist|playwright install/.test(String(error))) {
                throw error;
            }
        }
    }
    return null;
};

const browser = await open();
if (browser === null) {
    console.log("mark alignment: skipped, no Playwright browser on this machine (`pnpm install`, then `pnpm exec playwright install chromium`)");
    process.exit(0);
}

const { dev } = await import("astro");
const server = await dev({ root, logLevel: "error", server: { port: 0 } });
const origin = `http://localhost:${server.address.port}`;

// One route at one width. A page that will not load is a problem; a width that draws no marks is not, since the
// bar hides its flyout on a phone. Whether a ROUTE has stopped having marks at all is decided once, below.
const visit = async (page, route, viewport) => {
    const response = await page.goto(`${origin}${route}`, { waitUntil: "load" });
    if (response === null || !response.ok()) {
        return { measured: 0, problems: [`${route} (${viewport.label}): did not render \u2014 ${response === null ? "no response" : response.status()}`] };
    }
    const rows = await page.evaluate(audit);
    return { measured: rows.length, problems: faults(rows, route, viewport) };
};

const problems = [];
const perRoute = new Map(ROUTES.map((route) => [route, 0]));
try {
    for (const viewport of VIEWPORTS) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
        for (const route of ROUTES) {
            const result = await visit(page, route, viewport);
            perRoute.set(route, perRoute.get(route) + result.measured);
            problems.push(...result.problems);
        }
        await page.close();
    }
} finally {
    await browser.close();
    await server.stop();
}

/* A route that draws no marks at any width is measuring nothing, and a check that measures nothing passes for
 * the wrong reason — which is how a gate like this quietly stops being one. */
for (const [route, count] of perRoute) {
    if (count === 0) {
        problems.push(`${route}: no marks at any width \u2014 if the page changed, point ROUTES at one that has them`);
    }
}
const measured = [...perRoute.values()].reduce((total, count) => total + count, 0);

if (problems.length > 0) {
    for (const problem of problems) {
        console.error(problem);
    }
    console.error(`\n${problems.length} misaligned mark(s) of ${measured} measured. The rule that places them is \`.mark\` in src/styles/global.css.`);
    process.exit(1);
}

console.log(`mark alignment: ${measured} marks across ${ROUTES.length} routes at ${VIEWPORTS.length} widths, every one within ${TOLERANCE}px of its line`);
