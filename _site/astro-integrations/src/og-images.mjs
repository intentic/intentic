// @ts-check
// An OpenGraph card for every built page whose og:image names its own card (og-image-url.mjs): the page's tags are read
// from the HTML Astro just wrote, the site's `render` describes the card as a satori element tree, and resvg rasterizes
// it to a PNG beside the page.
//
// This replaced astro-opengraph-images (2026-10-27), which drew the same cards with the same satori and resvg but spent
// two of the site build's two and a half minutes doing it: it parsed every page with jsdom (~100 ms each) only to read
// five <meta> tags, then rasterized one card at a time on the main thread. Here the tags come from a regex over <head>
// (as llms-text.mjs reads its meta), and each card goes to resvg's `renderAsync`, which runs on libuv's thread pool, so
// satori lays out the next card while the last ones are drawn.

import { availableParallelism } from "node:os";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ogImageUrl } from "./og-image-url.mjs";

/** Cards in flight at once: enough to keep resvg's pool (four threads by default) busy behind satori's layout. */
const IN_FLIGHT = Math.max(2, Math.min(8, availableParallelism()));

/** The og: tags a card is drawn from, in the page's <head>; Astro writes `property` before `content`. */
const OG_META = /<meta\s+property="og:(title|description|url|image)"\s+content="([^"]*)"/giu;

const NAMED_ENTITIES = /** @type {Record<string, string>} */ ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" });

/**
 * An attribute value as a browser reads it. Astro escapes `& < > " '`; numeric references are decoded for anything else.
 * @param {string} value
 */
function decodeAttribute(value) {
    return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, body) => {
        if (body.startsWith("#")) {
            const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
}

/**
 * The first og:title, og:description, og:url and og:image in the page's <head>, decoded. A description that only repeats
 * the title is dropped, so a card never says the same sentence twice.
 * @param {string} html
 * @returns {{ title: string | undefined, description: string | undefined, url: string | undefined, image: string | undefined }}
 */
export function readOgTags(html) {
    const headEnd = html.indexOf("</head>");
    const head = headEnd === -1 ? html : html.slice(0, headEnd);
    /** @type {Record<string, string>} */
    const tags = {};
    for (const [, name, content] of head.matchAll(OG_META)) {
        if (name !== undefined && content !== undefined && content !== "" && tags[name] === undefined) {
            tags[name] = decodeAttribute(content);
        }
    }
    const { title, description, url, image } = tags;
    return { title, description: description === title ? undefined : description, url, image };
}

/** @param {string} file */
const exists = (file) =>
    access(file).then(
        () => true,
        () => false,
    );

/**
 * The HTML file Astro wrote for a route: `<route>/index.html`, or `<route>.html` for the 404 and 500 pages.
 * @param {string} distDir
 * @param {string} pathname
 */
async function htmlFileFor(distDir, pathname) {
    const nested = path.join(distDir, pathname, "index.html");
    return (await exists(nested)) ? nested : path.join(distDir, `${pathname.replace(/\/$/u, "")}.html`);
}

/**
 * Runs `task` over `items` with at most `limit` in flight; the first failure rejects once every started task settles.
 * @template T
 * @param {T[]} items
 * @param {number} limit
 * @param {(item: T) => Promise<void>} task
 */
async function eachLimited(items, limit, task) {
    let next = 0;
    const lane = async () => {
        while (next < items.length) {
            const item = /** @type {T} */ (items[next++]);
            await task(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
}

/**
 * @param {import("./og-images.d.ts").OgImagesOptions} options
 * @returns {import("astro").AstroIntegration}
 */
export function ogImages({ width, height, fonts, render }) {
    return {
        name: "intentic-og-images",
        hooks: {
            "astro:build:done": async ({ dir, pages, logger }) => {
                // Loaded when a build finishes rather than when the config loads, so `astro dev` never pays for them.
                const [{ default: satori }, { renderAsync }] = await Promise.all([import("satori"), import("@resvg/resvg-js")]);
                const distDir = fileURLToPath(dir);

                /** @type {import("./og-images.d.ts").OgTools["rasterize"]} */
                const rasterize = async (node, size) => {
                    // satori is typed for React elements; a plain `{ type, props }` tree is what JSX compiles to.
                    const svg = await satori(/** @type {never} */ (node), { width: size.width, height: size.height, fonts });
                    const image = await renderAsync(svg, { font: { loadSystemFonts: false }, fitTo: { mode: "width", value: size.width } });
                    return image.asPng();
                };
                const tools = { rasterize };

                let drawn = 0;
                await eachLimited(pages, IN_FLIGHT, async ({ pathname }) => {
                    const htmlFile = await htmlFileFor(distDir, pathname);
                    const tags = readOgTags(await readFile(htmlFile, "utf8"));
                    if (tags.url === undefined || tags.image !== ogImageUrl(new URL(tags.url))) {
                        return;
                    }
                    if (tags.title === undefined) {
                        throw new Error(`${htmlFile} asks for its own OpenGraph card (${tags.image}) but has no og:title to put on it.`);
                    }

                    // The card must land where og:image says, or every share of the page shows a broken picture.
                    const pngFile = htmlFile.replace(/\.html$/u, ".png");
                    const relative = path.relative(distDir, pngFile).replaceAll("\\", "/");
                    if (decodeURIComponent(new URL(tags.image).pathname.slice(1)) !== relative) {
                        throw new Error(`The og:image in ${htmlFile} (${tags.image}) is not where its card is written (${relative}).`);
                    }

                    const node = await render({ pathname, title: tags.title, description: tags.description, url: tags.url }, tools);
                    await writeFile(pngFile, await rasterize(node, { width, height }));
                    drawn += 1;
                });
                logger.info(`${drawn} OpenGraph cards drawn.`);
            },
        },
    };
}
