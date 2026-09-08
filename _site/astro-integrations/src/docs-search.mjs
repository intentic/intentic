// @ts-check
// Docs search index, built from pages as they render, not their .astro source: a source scraper can't read
// `{rows.map(...)}` tables or nested braces, so it drops content and leaks raw expressions into previews. A build reads
// dist directly; `astro dev` fetches over HTTP, but both call blocksFromPage so search behaves identically.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseHtml } from "./html-to-markdown.mjs";

/** Chrome and code samples; a shell-snippet-full index matches every query containing "docker". */
const DROPPED_TAGS = new Set(["script", "style", "svg", "noscript", "nav", "button", "template", "form", "input", "select", "pre"]);

/** Cells join with this, not a space, so "Maintainer · may change anything" reads as a row. */
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

/** Readable text for one subtree: no markup, cells delimited, code kept since route and field names are searched. */
function textOf(node) {
    if (node.type === "text") {
        return decodeEntities(node.value).replace(/\s+/g, " ");
    }
    if (DROPPED_TAGS.has(node.tag) || node.attrs["aria-hidden"] === "true" || node.attrs.hidden !== undefined) {
        return "";
    }
    const inner = node.children.map(textOf).join("");
    if (node.tag === "td" || node.tag === "th") {
        return `${inner.trim()}${CELL}`;
    }
    // A row ends a run of cells; drop the last cell's trailing separator, not run rows together.
    if (node.tag === "tr") {
        return `${inner.replace(/ · $/, "")} `;
    }
    return node.tag === "code" || node.tag === "a" || node.tag === "strong" || node.tag === "em" ? inner : `${inner} `;
}

function tidy(text) {
    return (
        text
            .replace(/\s+/g, " ")
            .replace(/(?: ·)+ ·/g, " ·")
            .replace(/ · $/, "")
            // Closes the gap a tag's trailing space leaves (`</strong>:` → "Automations :").
            .replace(/\s+([,;:!?)\]]|\.(?!\.))/g, "$1")
            .trim()
    );
}

/** A section of this page, or card furniture inside one? The renderer's rule: prose headings get an id, not a class. */
function isSectionHeading(node) {
    return node.type === "el" && (node.tag === "h2" || node.tag === "h3") && node.attrs.id !== undefined && node.attrs.class === undefined;
}

function hasSectionHeading(node) {
    if (node.type !== "el") {
        return false;
    }
    return node.children.some((child) => isSectionHeading(child) || hasSectionHeading(child));
}

function findByClass(nodes, className) {
    for (const node of nodes) {
        if (node.type !== "el") {
            continue;
        }
        if (node.attrs.class?.split(/\s+/).includes(className)) {
            return node;
        }
        const found = findByClass(node.children, className);
        if (found) {
            return found;
        }
    }
    return undefined;
}

/**
 * Splits a page's prose into heading-led blocks; sections, not pages, are the search unit, so a hit on a long reference
 * page can land on "Failures" rather than just the page title.
 * @param {string} html one rendered docs page
 * @returns {SearchBlock[]}
 */
export function blocksFromPage(html) {
    // .docs-body, not <article>: the article also holds the breadcrumb, header and prev/next footer.
    const body = findByClass(parseHtml(html), "docs-body");
    if (!body) {
        return [];
    }

    /** @type {SearchBlock[]} */
    const blocks = [];
    let current = { heading: "", anchor: "", text: "" };

    const walk = (nodes) => {
        for (const node of nodes) {
            if (isSectionHeading(node)) {
                blocks.push(current);
                // The anchor control renders empty (aria-hidden); its "#" never reaches the text.
                current = { heading: tidy(textOf(node)), anchor: node.attrs.id, text: "" };
                continue;
            }
            // Recurses only where a heading is hidden below, so a wrapped section still opens a block.
            if (hasSectionHeading(node)) {
                walk(node.children);
            } else {
                current.text += textOf(node);
            }
        }
    };
    walk(body.children);
    blocks.push(current);

    return blocks.map((block) => ({ ...block, text: tidy(block.text) })).filter((block) => block.heading !== "" || block.text !== "");
}

/**
 * Assembles the search index from pages and their rendered HTML.
 * @param {DocsSearchPage[]} pages
 * @param {(page: DocsSearchPage) => string | undefined} htmlFor
 * @returns {SearchEntry[]}
 */
export function docsSearchIndex(pages, htmlFor) {
    /** @type {SearchEntry[]} */
    const entries = [];
    for (const page of pages) {
        const html = htmlFor(page);
        if (html === undefined) {
            continue;
        }
        entries.push({ url: page.url, title: page.title, section: page.section, blurb: page.blurb, blocks: blocksFromPage(html) });
    }
    return entries;
}

/**
 * Writes dist/search.json from the built docs pages; lives at the site root, not under one book, since a search should
 * work regardless of which book has the answer.
 * @param {{ pages: DocsSearchPage[] }} options every page of every book, from the nav trees, so an unreachable page is
 * never indexed.
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
                        return readFileSync(path.join(distDir, page.url, "index.html"), "utf8");
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
