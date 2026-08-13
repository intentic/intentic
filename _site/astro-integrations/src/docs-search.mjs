// @ts-check
// The docs search index, built from the pages as they actually render.
//
// WHY NOT FROM THE SOURCE. The index used to be scraped out of each page's .astro source with regexes, and it
// could not see a table. Every long reference table on the site is written as `{rows.map(...)}` over an array in
// the frontmatter, and a source scraper reads that as one unreadable expression: 90 of the docs' 235 table rows
// were absent from the index — the access tiers, the supported model providers, 14 of the 16 rows of the
// integrations catalog, the automation triggers, the board lanes. Tables are exactly what people search for.
// The same regexes could not match nested braces either, so fragments of page source leaked into 16 sections'
// search previews and a reader could be shown `{ roles.map((role) => ()) }` as the answer to their question.
//
// Reading the rendered page removes the whole class of problem: a table is a table, and there is no source left
// to leak. The anchors come from the ids the renderer already put on the headings, so a hit cannot land on a
// section that moved.
//
// WHERE THE HTML COMES FROM. Two places, one extractor. In a build, the pages have just been written to dist and
// this integration reads them there. Under `astro dev` there is no dist, so the search.json route asks the dev
// server for the pages over HTTP — the same rendered HTML by a different road. Both call blocksFromPage below, so
// search behaves the same in the browser you are developing in as it does in production.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHtml } from "./html-to-markdown.mjs";

/** Chrome, and code samples. A search index full of shell snippets matches every query containing "docker". */
const DROPPED_TAGS = new Set(["script", "style", "svg", "noscript", "nav", "button", "template", "form", "input", "select", "pre"]);

/** Cells are joined with this rather than a space: "Maintainer · may change anything" reads as a row, not a run-on. */
const CELL = " · ";

/**
 * @typedef {{ type: "text", value: string } | { type: "el", tag: string, attrs: Record<string, string>, children: Node[] }} Node
 * @typedef {{ heading: string, anchor: string, text: string }} SearchBlock
 * @typedef {{ url: string, title: string, section: string, blurb: string, blocks: SearchBlock[] }} SearchEntry
 * @typedef {{ url: string, title: string, section: string, blurb: string }} DocsSearchPage
 */

const NAMED_ENTITIES = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    hellip: "…",
    mdash: "—",
    ndash: "–",
    rsquo: "’",
    lsquo: "‘",
    ldquo: "“",
    rdquo: "”",
    middot: "·",
    rarr: "→",
    larr: "←",
    lbrace: "{",
    rbrace: "}",
    dollar: "$",
};

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
        if (body[0] === "#") {
            const code = body[1] === "x" || body[1] === "X" ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
}

/** Readable text for one subtree — no markup, cells delimited, code kept because route and field names are searched. */
function textOf(node) {
    if (node.type === "text") return decodeEntities(node.value).replace(/\s+/g, " ");
    if (DROPPED_TAGS.has(node.tag) || node.attrs["aria-hidden"] === "true" || node.attrs.hidden !== undefined) return "";
    const inner = node.children.map(textOf).join("");
    if (node.tag === "td" || node.tag === "th") return `${inner.trim()}${CELL}`;
    // A row ends a sequence of cells: drop the last cell's trailing separator rather than running rows together.
    if (node.tag === "tr") return `${inner.replace(/ · $/, "")} `;
    return node.tag === "code" || node.tag === "a" || node.tag === "strong" || node.tag === "em" ? inner : `${inner} `;
}

function tidy(text) {
    return (
        text
            .replace(/\s+/g, " ")
            .replace(/(?: ·)+ ·/g, " ·")
            .replace(/ · $/, "")
            /* Tags render with a trailing space, so `<strong>Automations</strong>:` leaves "Automations :" — close that
             * gap back up. The lookahead spares a leading ellipsis: `execute(command, ...args)` is a signature people
             * search for, and "command,...args" is not what they would type. */
            .replace(/\s+([,;:!?)\]]|\.(?!\.))/g, "$1")
            .trim()
    );
}

/** A section of this page, or card furniture inside one? The renderer's rule: prose headings get an id, not a class. */
function isSectionHeading(node) {
    return node.type === "el" && (node.tag === "h2" || node.tag === "h3") && node.attrs.id !== undefined && node.attrs.class === undefined;
}

function hasSectionHeading(node) {
    if (node.type !== "el") return false;
    return node.children.some((child) => isSectionHeading(child) || hasSectionHeading(child));
}

/** Find the element carrying a class, anywhere in the tree. */
function findByClass(nodes, className) {
    for (const node of nodes) {
        if (node.type !== "el") continue;
        if (node.attrs.class?.split(/\s+/).includes(className)) return node;
        const found = findByClass(node.children, className);
        if (found) return found;
    }
    return undefined;
}

/**
 * Split a page's prose into heading-led blocks.
 *
 * SECTIONS, NOT PAGES, are the unit: a hit on a nine-screen reference page is nearly useless if it can only say
 * "HTTP API" — it has to say "Failures", and land there.
 *
 * @param {string} html one rendered docs page
 * @returns {SearchBlock[]}
 */
export function blocksFromPage(html) {
    /* .docs-body, not <article>: the article also holds the breadcrumb, the page header and the previous/next
     * footer, and indexing those makes every page match the shelf it is on and the pages either side of it. */
    const body = findByClass(parseHtml(html), "docs-body");
    if (!body) return [];

    /** @type {SearchBlock[]} */
    const blocks = [];
    let current = { heading: "", anchor: "", text: "" };

    const walk = (nodes) => {
        for (const node of nodes) {
            if (isSectionHeading(node)) {
                blocks.push(current);
                // The heading's own anchor control renders empty (aria-hidden), so its "#" never reaches the text.
                current = { heading: tidy(textOf(node)), anchor: node.attrs.id, text: "" };
                continue;
            }
            // Recurse only where a heading is hidden below, so a wrapped section still opens a block.
            if (hasSectionHeading(node)) walk(node.children);
            else current.text += textOf(node);
        }
    };
    walk(body.children);
    blocks.push(current);

    return blocks.map((block) => ({ ...block, text: tidy(block.text) })).filter((block) => block.heading !== "" || block.text !== "");
}

/**
 * Assemble the index from pages and their HTML.
 * @param {DocsSearchPage[]} pages
 * @param {(page: DocsSearchPage) => string | undefined} htmlFor
 * @returns {SearchEntry[]}
 */
export function docsSearchIndex(pages, htmlFor) {
    /** @type {SearchEntry[]} */
    const entries = [];
    for (const page of pages) {
        const html = htmlFor(page);
        if (html === undefined) continue;
        entries.push({ url: page.url, title: page.title, section: page.section, blurb: page.blurb, blocks: blocksFromPage(html) });
    }
    return entries;
}

/**
 * Write dist/search.json from the documentation pages that were just built.
 *
 * At the site root rather than under one book, because there is one index across both of them: a reader
 * searching for a word should not have to know whether it is documented for users or for authors.
 *
 * @param {{ pages: DocsSearchPage[] }} options every page of every book, from the trees — so a page a rail
 * cannot reach is never indexed, and the shelf label a result shows is the one the reader navigates by.
 * @returns {import('astro').AstroIntegration}
 */
export default function docsSearch(options) {
    return {
        name: "intentic-docs-search",
        hooks: {
            "astro:build:done": ({ dir, logger }) => {
                const distDir = fileURLToPath(dir);
                const entries = docsSearchIndex(options.pages, (page) => {
                    try {
                        return readFileSync(path.join(distDir, page.url, "index.html"), "utf-8");
                    } catch {
                        logger.warn(`No built page for ${page.url}; it will be missing from search.`);
                        return undefined;
                    }
                });

                const outPath = path.join(distDir, "search.json");
                mkdirSync(path.dirname(outPath), { recursive: true });
                writeFileSync(outPath, JSON.stringify({ entries }));

                const blocks = entries.reduce((total, entry) => total + entry.blocks.length, 0);
                logger.info(`Documentation search index written: ${entries.length} pages, ${blocks} sections.`);
            },
        },
    };
}
