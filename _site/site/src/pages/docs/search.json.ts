import { docsHref, docsPlacements } from "@intentic-dev/site-content/docs";
import type { APIRoute } from "astro";
import { slugify } from "../../lib/docs-headings";

/* The docs search index, built from the pages' own source at build time.
 *
 * WHY THERE WAS NO SEARCH: twenty pages, one of them a forty-row route table, and the only way in was guessing
 * which shelf held the word you wanted. Someone who knows they need "webhook" should not have to know whether
 * that lives under automations, the HTTP API, or the doorbell guide. (It is all three.)
 *
 * WHERE THE TEXT COMES FROM. Vite hands us each page's raw source via import.meta.glob, and we strip it to
 * prose here. The alternative was the markdown mirrors the llms.txt integration already produces, which are
 * cleaner text — but those are written at astro:build:done, so search would exist in production and be empty
 * in dev, where it is being worked on. One index that behaves identically in both is worth a little more
 * stripping work.
 *
 * SECTIONS, NOT PAGES, are the unit. A hit on a twenty-screen reference page is nearly useless if it only says
 * "HTTP API"; it has to land on "Failures". Each heading opens a block, and the block's text is everything up to
 * the next heading — so every result carries the anchor that heading was given, and the ids come from the same
 * slugify() the renderer uses, so they cannot drift.
 */

// eager: the index is one JSON file built once, so there is nothing to gain by deferring the imports.
const sources = import.meta.glob<string>("./**/*.astro", { query: "?raw", import: "default", eager: true });

export interface SearchBlock {
    /** Section heading, or "" for the text above the first one. */
    heading: string;
    /** Anchor for that heading, or "" when there is none to link to. */
    anchor: string;
    text: string;
}

export interface SearchEntry {
    url: string;
    title: string;
    /** Shelf label, so a result can say which part of the docs it is from. */
    section: string;
    blurb: string;
    blocks: SearchBlock[];
}

/** `./sandbox-api/host.astro` → `sandbox-api/host`; `./index.astro` → `` */
function idForSource(key: string): string {
    return key.replace(/^\.\//, "").replace(/\.astro$/, "").replace(/(^|\/)index$/, "");
}

/** Everything between the frontmatter fence and the end — the markup, without the component's script. */
function bodyOf(source: string): string {
    const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(source);
    return match ? match[1] : source;
}

function decode(text: string): string {
    return text
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&nbsp;/g, " ");
}

/**
 * Source markup → readable prose.
 *
 * Order matters: comments and whole elements whose content is not prose go first, so their innards are never
 * mistaken for text. `<Code code={...}>` blocks are dropped wholesale — a search index full of shell snippets
 * matches every query containing "docker" and ranks the least useful page first.
 */
function prose(markup: string): string {
    return decode(
        markup
            .replace(/<!--[\s\S]*?-->/g, " ")
            .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
            .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
            // Self-closing components and their props: <DocsCodeBlock code={...} />, <ProductFigure ... />
            .replace(/<[A-Z][\w.]*[\s\S]*?\/>/g, " ")
            // JSX expression containers: className lists, .map() bodies, template literals.
            .replace(/\{[^{}]*\}/g, " ")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            // Tags are replaced with a space rather than nothing, so `<strong>Automations</strong>:` leaves
            // "Automations :" — which is what a snippet then shows the reader. Close the gap back up.
            .replace(/\s+([,.;:!?)\]])/g, "$1")
            .replace(/([([])\s+/g, "$1")
            .trim(),
    );
}

/** Split a page's markup into heading-led blocks, mirroring how the renderer anchors those headings. */
function blocksOf(markup: string): SearchBlock[] {
    const blocks: SearchBlock[] = [];
    // Same rule the renderer uses: a heading carrying a class is card furniture, not a section of the page.
    const pattern = /<h([23])((?:\s+(?!class=)[^\s>]+(?:="[^"]*")?)*)\s*>([\s\S]*?)<\/h\1>/g;
    let cursor = 0;
    let pending: { heading: string; anchor: string } = { heading: "", anchor: "" };
    const used = new Set<string>();

    for (let match = pattern.exec(markup); match !== null; match = pattern.exec(markup)) {
        const text = prose(match[3]);
        if (text === "") continue;

        const body = prose(markup.slice(cursor, match.index));
        if (body !== "" || pending.heading !== "") blocks.push({ ...pending, text: body });

        const authored = /\sid="([^"]*)"/.exec(match[2])?.[1];
        let anchor = authored ?? slugify(text);
        if (used.has(anchor)) {
            let suffix = 2;
            while (used.has(`${anchor}-${suffix}`)) suffix += 1;
            anchor = `${anchor}-${suffix}`;
        }
        used.add(anchor);

        pending = { heading: text, anchor };
        cursor = match.index + match[0].length;
    }

    const tail = prose(markup.slice(cursor));
    if (tail !== "" || pending.heading !== "") blocks.push({ ...pending, text: tail });
    return blocks;
}

export const GET: APIRoute = () => {
    const byId = new Map(Object.entries(sources).map(([key, source]) => [idForSource(key), source]));

    /* Driven by the TREE, not by the glob: a page's shelf and title come from the docs tree, and a source file
     * with no tree entry is not part of the docs — it is a route that has not been shelved, and indexing it
     * would surface a page the sidebar cannot reach. */
    const entries: SearchEntry[] = docsPlacements.flatMap(({ page, section }) => {
        const source = byId.get(page.id);
        if (source === undefined) return [];
        return [
            {
                url: docsHref(page.id),
                title: page.title,
                section: section.label,
                blurb: page.blurb,
                blocks: blocksOf(bodyOf(source)).filter((block) => block.heading !== "" || block.text !== ""),
            },
        ];
    });

    return new Response(JSON.stringify({ entries }), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            // Content-addressed by deploy, not by request: the index changes only when the docs are rebuilt.
            "cache-control": "public, max-age=3600",
        },
    });
};
