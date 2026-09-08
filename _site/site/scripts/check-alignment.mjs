#!/usr/bin/env node
// Browser half of the mark-alignment gate (static half: `_tools/checks/mark-alignment.mjs`): asserts every mark sits
// inside `.mark`, centred within a pixel of the text's first line beside it, not the row. `.lockup` is excluded
// (aligned on the letters). Skips rather than fails when no browser is available.
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// Pages with marks (landing, pricing, about, a feature page); a route with none at any width fails outright.
const ROUTES = ["/", "/pricing/", "/about/", "/features/review/"];
// Wide (two-column layouts) and phone; the bar redraws its wordmark at a second size below 30rem.
const VIEWPORTS = [
    { label: "wide", width: 1280, height: 900 },
    { label: "narrow", width: 390, height: 844 },
];
// A mark's centre may differ from the line's centre by this much. Half a pixel is rounding; three is visible.
const TOLERANCE = 1;

// The measurement, run inside the page; self-contained since it's serialised to the browser and can't close over this
// file.
const audit = () => {
    const MARK = ".mark, .lotus, .lozenge";

    const label = (element) => {
        const classes = typeof element.className === "string" ? element.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
        const words = (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 44);
        return `${element.tagName.toLowerCase()}${classes === "" ? "" : `.${classes}`} \u201c${words}\u201d`;
    };

    // The row a mark must align inside, or null when it doesn't apply: a finial, a divider knot, a solo mark, an
    // already-measured wrapper, or the lockup wordmark (aligned on its letters).
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

    // Distance from the mark's centre to the centre of the text's first line box (inside border+padding, `line-height`
    // tall); positive is below.
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

// Tries the headless shell and full chromium before giving up; having only one installed is normal.
// `undefined` only when Playwright isn't installed at all: an unset-up tree, not a wrong one.
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

// One route at one width: a failed load is a problem, but zero marks isn't (the flyout hides on phone). Whether a route
// has none at any width is decided later.
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

// A route with no marks at any width measures nothing; a check that measures nothing passes for the wrong reason.
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
