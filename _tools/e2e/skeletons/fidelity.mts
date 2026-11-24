/* Skeleton fidelity: every loading placeholder the demo draws, scored against the content that replaces it. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { insidePath, page as pages, type PageLink } from "@intentic/sandbox-contract/app-routes";
import { type Browser, type BrowserContext, chromium, type Page } from "@playwright/test";
import { DEMO_SANDBOX } from "../fixtures/demo-pages.ts";

// WHAT A FIRST VISIT DRAWS WHILE IT WAITS, AND WHETHER THE ANSWER LANDS ON IT. A view's remembered look (<Await>'s
// imprint, @intentic/ui lib/skeleton) is taken from the view itself, so it cannot drift; the hand-drawn `#fallback`
// that stands in until the view has been seen once can, and does, silently, because nothing ever showed it beside the
// content it promises. This walks the demo twice per surface, each time in an empty browser (no imprint, no query
// cache: a first visit):
//   1. with the daemon's reads held (`?reads=stalled`, _site/demo/src/reads.ts), or a route's code held (`hold`),
//      and finds every placeholder on screen: a busy status region, a remembered look, a loose `.skeleton` bar;
//   2. with nothing held, and reads the content in the same rectangles.
// Each placeholder's region runs from its top to the bottom of the viewport, so a placeholder shorter than its content,
// or one that pushes what follows it, scores as the jump it is. The score is a Dice coefficient over 8px cells of ink
// (text lines, glyphs, fields and skeleton bars), lenient by one cell each way: 1 is the same shape, under 0.5 a
// different one.
//
//   node --experimental-strip-types skeletons/fidelity.mts --origin=http://127.0.0.1:<port>   # a running demo (`preview demo`, or `pnpm -C _site/demo dev`)
//   … --only=secrets                 surfaces whose name holds this
//   … --shots=/tmp/skeletons         the placeholder and the content as two screenshots, each region outlined
//   … --imprints                     a second visit instead: the remembered look, not the hand-drawn fallback
//   … --json                         the scores as data
// It fails under FAIL_BELOW, except on a surface whose placeholder is generic by design (`generic`): the outline drawn
// while a route's or a section's code is on its way, or an extension's view never seen, promises the shape most pages
// have, and the page's own look replaces it once the page has been seen here or in any other sandbox (the store's
// `lends`). Those are reported, marked `~`. It never builds or starts the demo itself.

const BASE = "/demo";
const VIEWPORT = { width: 1440, height: 900 };
const CELL = 8;
// An SVG larger than this on either side is a drawing, not a glyph (skeletonImprint.ts keeps the same line).
const DRAWING_SIDE = 64;
const FAIL_BELOW = 0.5;
// Long enough for a placeholder past <Await>'s reveal delay; content gets its reads and its reveal hold.
const PLACEHOLDER_SETTLE_MS = 1_800;
const CONTENT_SETTLE_MS = 4_000;

interface Surface {
    readonly name: string;
    readonly path: string;
    /** Module addresses held unanswered, so the route's or a section's own code is what is waited for. */
    readonly hold?: readonly string[];
    /** The demo's mode (_site/demo/src/mode.ts): `full` switches every extension on. */
    readonly mode?: `full`;
    /**
     * Only the reads whose path holds this are held (_site/demo/src/reads.ts `readsMatch`): a region inside a view whose
     * own first reads must answer before the region is drawn at all, as an extension's view needs its manifest.
     */
    readonly readsMatch?: string;
    /** Its placeholder is one outline for every page of its kind: reported, never failed (see the header). */
    readonly generic?: true;
}

const inDemo = (link: PageLink): string => insidePath(DEMO_SANDBOX, link);
const hub = (tab: string): string => inDemo(pages.sandboxSettings(tab));
const account = (tab: string): string => `${insidePath(DEMO_SANDBOX)}/account/${tab}`;

const HUB_SECTIONS = [
    [`overview`, `SandboxOverview`],
    [`usage`, `SandboxUsage`],
    [`secrets`, `SandboxSecrets`],
    [`data-protection`, `SandboxDataProtection`],
    [`privacy-shield`, `SandboxPrivacyShield`],
    [`guardrails`, `SandboxGuardrails`],
    [`retention`, `SandboxRetention`],
    [`activity`, `SandboxActivity`],
    [`environment`, `SandboxEnvironment`],
    [`map`, `SandboxMap`],
    [`access`, `SandboxAccess`],
    [`roles`, `SandboxRoles`],
    [`models`, `SandboxModels`],
    [`agent`, `SandboxAgent`],
    [`extensions`, `SandboxExtensions`],
] as const;

const SURFACES: readonly Surface[] = [
    { name: `agents`, path: inDemo(pages.agents()) },
    { name: `agent`, path: inDemo(pages.agent(`cnv_checkout_stripe`)) },
    { name: `workspace`, path: inDemo(pages.workspace()) },
    { name: `workspace-file`, path: inDemo(pages.workspace(`web/src/pricing/CheckoutPanel.tsx`)) },
    { name: `devices`, path: inDemo(pages.devices()) },
    { name: `capabilities`, path: inDemo(pages.capabilities()) },
    { name: `browsers`, path: inDemo(pages.browsers()) },
    ...[`run`, `pipelines`, `approvals`, `automations`, `git-history`, `preview`, `acceptance`, `documentation`, `knowledge`, `issues`, `deployments`].map(
        // With every read held the host never learns the view's manifest, so what shows is its outline for any view.
        (ext) => ({ name: `ext-${ext}`, path: inDemo(pages.extension(ext)), mode: `full` as const, generic: true as const }),
    ),
    ...HUB_SECTIONS.map(([tab]) => ({ name: `hub-${tab}`, path: hub(tab) })),
    ...[`profile`, `billing`, `access`, `tokens`, `data`].map((tab) => ({ name: `account-${tab}`, path: account(tab) })),
    // The outlines drawn while code is on its way: the hub's route outline, then a section's under a drawn hub.
    { name: `route-hub`, path: hub(`secrets`), hold: [`/SandboxHub`], generic: true },
    { name: `route-account`, path: account(`profile`), hold: [`/SettingsHub`], generic: true },
    { name: `route-capabilities`, path: inDemo(pages.capabilities()), hold: [`/Capabilities.vue`, `/Capabilities-`], generic: true },
    ...HUB_SECTIONS.map(([tab, component]) => ({
        name: `section-${tab}`,
        path: hub(tab),
        hold: [`/${component}.vue`, `/${component}-`],
        generic: true as const,
    })),
];

interface Region {
    readonly label: string;
    readonly x: number;
    readonly y: number;
    readonly w: number;
    readonly h: number;
}

interface Scored extends Region {
    readonly score: number;
}

interface Result {
    readonly surface: string;
    readonly generic: boolean;
    readonly mode: `reads` | `code`;
    readonly regions: readonly Scored[];
    readonly error?: string;
}

/* The placeholders on screen, outermost only, as regions from their top to the foot of the viewport. Browser realm. */
const findPlaceholders = (page: Page): Promise<Region[]> =>
    page.evaluate(() => {
        // A boxless element (a remembered look is drawn from <Await>'s `display: contents` answer) is the union of what it lays out.
        const boxOf = (element: Element): DOMRect => {
            if (getComputedStyle(element).display !== `contents`) {
                return element.getBoundingClientRect();
            }
            const boxes = [...element.children].map(boxOf).filter((box) => box.width > 0 && box.height > 0);
            if (boxes.length === 0) {
                return new DOMRect();
            }
            const left = Math.min(...boxes.map((box) => box.left));
            const top = Math.min(...boxes.map((box) => box.top));
            return new DOMRect(left, top, Math.max(...boxes.map((box) => box.right)) - left, Math.max(...boxes.map((box) => box.bottom)) - top);
        };
        const visible = (element: Element): boolean => {
            const rect = boxOf(element);
            // `checkVisibility` is false for a boxless element whatever it lays out, so it asks only of one with a box.
            const shown = getComputedStyle(element).display === `contents` || element.checkVisibility({ opacityProperty: true });
            return rect.width >= 4 && rect.height >= 4 && rect.bottom > 0 && rect.top < innerHeight && shown;
        };
        const marked = [...document.querySelectorAll(`[aria-busy="true"], [data-skeleton-snapshot], .skeleton`)].filter(visible);
        const outermost = marked.filter((element) => !marked.some((other) => other !== element && other.contains(element)));
        const labelOf = (element: Element): string => {
            const said = element.getAttribute(`aria-label`);
            if (said !== null && said !== ``) {
                return said;
            }
            const heading = element.closest(`section, [role=region], main`)?.querySelector(`h1, h2, h3, [data-section-title]`)?.textContent?.trim();
            return `${element.localName}.${[...element.classList].slice(0, 4).join(`.`)}${heading ? ` under “${heading.slice(0, 40)}”` : ``}`;
        };
        const regions = outermost.map((element) => {
            const rect = boxOf(element);
            return { label: labelOf(element), x: Math.max(0, rect.left), y: Math.max(0, rect.top), w: rect.width, h: innerHeight - Math.max(0, rect.top) };
        });
        // A run of bars in one column (a list of loose `.skeleton` rows) is one region, not one per bar.
        const merged: typeof regions = [];
        for (const region of regions.toSorted((left, right) => left.y - right.y)) {
            const into = merged.find(
                (held) => region.x < held.x + held.w && held.x < region.x + region.w && Math.abs(region.x - held.x) < 120 && region.y >= held.y,
            );
            if (into === undefined) {
                merged.push(region);
                continue;
            }
            const right = Math.max(into.x + into.w, region.x + region.w);
            into.x = Math.min(into.x, region.x);
            into.w = right - into.x;
        }
        return merged;
    });

/* Which 8px cells of each region hold ink: lines of text, glyphs, fields, skeleton bars. Browser realm. */
const inkIn = (page: Page, regions: readonly Region[]): Promise<number[][]> =>
    page.evaluate(
        ({ regions: all, cell, drawing }) => {
            const rects: DOMRect[] = [];
            const range = document.createRange();
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
            const SOLID = new Set([`img`, `svg`, `input`, `textarea`, `select`, `canvas`, `video`, `iframe`, `progress`, `meter`]);
            for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
                if (node instanceof Text) {
                    const parent = node.parentElement;
                    if (/\S/.test(node.data) && parent !== null && parent.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
                        range.selectNodeContents(node);
                        rects.push(...range.getClientRects());
                    }
                    continue;
                }
                if (!(node instanceof Element)) {
                    continue;
                }
                if (node.id === `demo-switcher`) {
                    continue;
                }
                const solid = SOLID.has(node.localName) || node.classList.contains(`skeleton`) || node.getAttribute(`role`) === `switch`;
                if (!solid || !node.checkVisibility({ opacityProperty: true, visibilityProperty: true })) {
                    continue;
                }
                const box = node.getBoundingClientRect();
                // A drawing bigger than a glyph (a map's edges, a chart) is mostly empty space, not ink: its marks are
                // what the rest of the page draws on it. The imprint keeps such a drawing's space and draws nothing in
                // it, for the same reason (skeletonImprint.ts `DRAWING_SIDE`).
                if (node.localName === `svg` && (box.width > drawing || box.height > drawing)) {
                    continue;
                }
                rects.push(box);
            }
            return all.map((region) => {
                const columns = Math.ceil(region.w / cell);
                const cells = new Set<number>();
                for (const rect of rects) {
                    if (rect.width < 2 || rect.height < 2) {
                        continue;
                    }
                    const left = Math.max(rect.left, region.x);
                    const right = Math.min(rect.right, region.x + region.w);
                    const top = Math.max(rect.top, region.y);
                    const bottom = Math.min(rect.bottom, region.y + region.h);
                    if (right <= left || bottom <= top) {
                        continue;
                    }
                    for (let row = Math.floor((top - region.y) / cell); row <= Math.floor((bottom - region.y - 0.01) / cell); row++) {
                        for (let column = Math.floor((left - region.x) / cell); column <= Math.floor((right - region.x - 0.01) / cell); column++) {
                            cells.add(row * columns + column);
                        }
                    }
                }
                return [...cells];
            });
        },
        { regions, cell: CELL, drawing: DRAWING_SIDE },
    );

/* Dice over cells, where a cell counts as met when the other side has ink within one cell of it. */
const fidelity = (region: Region, placeholder: readonly number[], content: readonly number[]): number => {
    if (placeholder.length === 0 && content.length === 0) {
        return 1;
    }
    const columns = Math.ceil(region.w / CELL);
    const near = (cells: ReadonlySet<number>, index: number): boolean => {
        const row = Math.floor(index / columns);
        const column = index % columns;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const x = column + dx;
                if (x >= 0 && x < columns && cells.has((row + dy) * columns + x)) {
                    return true;
                }
            }
        }
        return false;
    };
    const ours = new Set(placeholder);
    const theirs = new Set(content);
    const met = placeholder.filter((index) => near(theirs, index)).length + content.filter((index) => near(ours, index)).length;
    return met / (placeholder.length + content.length);
};

const booted = async (page: Page): Promise<void> => {
    await page.waitForFunction(() => document.body.innerText.length > 50, undefined, { timeout: 30_000 });
};

// A browser that has seen the surface once: its look remembered (imprints), and everything else it kept forgotten (the
// query cache, the transcripts), so its next visit waits again and draws what it remembered. The first load opens the
// account's drawer, which the imprints' database is named for: a page that opened before it wrote elsewhere.
const remembered = async (browser: Browser, origin: string, surface: Surface): Promise<BrowserContext> => {
    const context = await browser.newContext({ viewport: VIEWPORT, colorScheme: `light` });
    const page = await context.newPage();
    const mode = surface.mode === undefined ? `` : `?mode=${surface.mode}`;
    await page.goto(`${origin}${BASE}${inDemo(pages.agents())}${mode}`, { waitUntil: `domcontentloaded` });
    await booted(page);
    await page.goto(`${origin}${BASE}${surface.path}`, { waitUntil: `domcontentloaded` });
    await booted(page);
    // Settled, taken at idle, then written in a batch: the store's own timings, with room.
    await page.waitForTimeout(CONTENT_SETTLE_MS + 5_000);
    // Off the app, so nothing holds the databases open while they go.
    await page.goto(`${origin}${BASE}/@vite/client`);
    await page.evaluate(async () => {
        const gone = (name: string): Promise<void> =>
            new Promise((resolve) => {
                const request = indexedDB.deleteDatabase(name);
                request.addEventListener(`success`, () => resolve());
                request.addEventListener(`error`, () => resolve());
                request.addEventListener(`blocked`, () => resolve());
            });
        const names = (await indexedDB.databases()).map((database) => database.name ?? ``);
        await Promise.all(names.filter((name) => name === `keyval-store` || name.startsWith(`intentic.chat`)).map(gone));
    });
    await page.close();
    return context;
};

const imprints = process.argv.includes(`--imprints`);

const open = async (browser: Browser, origin: string, surface: Surface, held: boolean): Promise<{ context: BrowserContext; page: Page }> => {
    const context =
        held && imprints ? await remembered(browser, origin, surface) : await browser.newContext({ viewport: VIEWPORT, colorScheme: `light` });
    if (held && surface.hold !== undefined) {
        const patterns = surface.hold;
        // Never answered: the code stays on its way for as long as the page is measured.
        await context.route((url) => patterns.some((pattern) => url.pathname.includes(pattern)), () => undefined);
    }
    const page = await context.newPage();
    const reads = held && surface.hold === undefined ? `stalled` : `none`;
    const glue = surface.path.includes(`?`) ? `&` : `?`;
    const mode = surface.mode === undefined ? `` : `&mode=${surface.mode}`;
    // Named every time, `none` included: the demo keeps both for the tab's session.
    const match = `&readsMatch=${encodeURIComponent(held && surface.readsMatch !== undefined ? surface.readsMatch : `none`)}`;
    await page.goto(`${origin}${BASE}${surface.path}${glue}reads=${reads}${mode}${match}`, { waitUntil: `domcontentloaded` });
    await page.addStyleTag({ content: `#demo-switcher { display: none !important; }` });
    await booted(page);
    return { context, page };
};

const outline = (page: Page, regions: readonly Region[]): Promise<void> =>
    page.evaluate((all) => {
        for (const region of all) {
            const box = document.createElement(`div`);
            box.setAttribute(`style`, `position:fixed;z-index:99999;pointer-events:none;outline:2px dashed #e11d48;left:${region.x}px;top:${region.y}px;width:${region.w}px;height:${region.h}px`);
            document.body.append(box);
        }
    }, regions);

const audit = async (browser: Browser, origin: string, surface: Surface, shots: string | undefined): Promise<Result> => {
    const mode = surface.hold === undefined ? `reads` : `code`;
    try {
        const waiting = await open(browser, origin, surface, true);
        await waiting.page.waitForTimeout(PLACEHOLDER_SETTLE_MS);
        const regions = await findPlaceholders(waiting.page);
        const placeholderInk = await inkIn(waiting.page, regions);
        if (shots !== undefined && regions.length > 0) {
            await outline(waiting.page, regions);
            await waiting.page.screenshot({ path: join(shots, `${surface.name}-1-placeholder.png`) });
        }
        await waiting.context.close();
        if (regions.length === 0) {
            return { surface: surface.name, generic: surface.generic === true, mode, regions: [] };
        }
        const loaded = await open(browser, origin, surface, false);
        await loaded.page.waitForTimeout(CONTENT_SETTLE_MS);
        const contentInk = await inkIn(loaded.page, regions);
        if (shots !== undefined) {
            await outline(loaded.page, regions);
            await loaded.page.screenshot({ path: join(shots, `${surface.name}-2-content.png`) });
        }
        await loaded.context.close();
        const scored = regions.map((region, index) => ({ ...region, score: fidelity(region, placeholderInk[index] ?? [], contentInk[index] ?? []) }));
        return { surface: surface.name, generic: surface.generic === true, mode, regions: scored };
    } catch (error) {
        return { surface: surface.name, generic: surface.generic === true, mode, regions: [], error: String(error).split(`\n`)[0] };
    }
};

const argument = (name: string): string | undefined => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);

const run = async (): Promise<void> => {
    const origin = argument(`origin`);
    if (origin === undefined) {
        throw new Error(`Name a running demo: --origin=http://127.0.0.1:<port> (\`preview demo\`, or \`pnpm -C _site/demo dev\`)`);
    }
    const only = argument(`only`);
    const shots = argument(`shots`);
    if (shots !== undefined) {
        mkdirSync(shots, { recursive: true });
    }
    const surfaces = only === undefined ? SURFACES : SURFACES.filter((surface) => surface.name.includes(only));
    const browser = await chromium.launch({ channel: `chromium` });
    const results: Result[] = [];
    try {
        for (const surface of surfaces) {
            results.push(await audit(browser, origin, surface, shots));
        }
    } finally {
        await browser.close();
    }
    if (process.argv.includes(`--json`)) {
        console.log(JSON.stringify(results, null, 2));
    } else {
        console.log(`\nSkeleton fidelity — ${imprints ? `second` : `first`} visit, ${VIEWPORT.width}×${VIEWPORT.height}; 1 is the content's own shape\n`);
        for (const result of results) {
            if (result.error !== undefined) {
                console.log(`✗ ${result.surface.padEnd(24)} ERROR ${result.error}`);
                continue;
            }
            if (result.regions.length === 0) {
                console.log(`· ${result.surface.padEnd(24)} no placeholder on screen`);
                continue;
            }
            for (const region of result.regions) {
                const mark = region.score >= FAIL_BELOW ? `✓` : result.generic ? `~` : `✗`;
                console.log(`${mark} ${result.surface.padEnd(24)} ${region.score.toFixed(2)}  ${Math.round(region.x)},${Math.round(region.y)} ${Math.round(region.w)}w  ${region.label}`);
            }
        }
    }
    const failed = results.filter(
        (result) => result.error !== undefined || (!result.generic && result.regions.some((region) => region.score < FAIL_BELOW)),
    );
    if (failed.length > 0) {
        console.error(`\n${failed.length} of ${results.length} surfaces draw a placeholder unlike their content: ${failed.map((result) => result.surface).join(`, `)}`);
        process.exitCode = 1;
    }
};

await run();
