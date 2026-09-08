import { blocksFromPage, type SearchEntry } from "@intentic/astro-integrations";
import { developersBook } from "@intentic/site-content/developers";
import { bookHref, bookPlacements } from "@intentic/site-content/book";
import { docsBook } from "@intentic/site-content/docs";
import type { APIRoute } from "astro";

// Documentation search index for both books, merged into one at the site root (a search term may live under any book or
// shelf); each result names its shelf. Reads pages as rendered, not source, so every table row is captured by one
// extractor. Served live here in dev; the build writes it from dist.

const pages = [docsBook, developersBook].flatMap((book) =>
    bookPlacements(book).map(({ page, section }) => ({
        url: bookHref(book, page.id),
        title: page.title,
        section: section.label,
        blurb: page.blurb,
    })),
);

// Cached once per dev-server run: a reload re-runs the module, and pages cannot change within a run.
let cached: Promise<SearchEntry[]> | undefined;

export const GET: APIRoute = async ({ request }) => {
    // A build reaches this route too; it answers empty, then docsSearch overwrites the file at astro:build:done.
    if (!import.meta.env.DEV) {
        return json({ entries: [] });
    }

    const origin = new URL(request.url).origin;
    cached ??= Promise.all(
        pages.map(async (page) => {
            const response = await fetch(`${origin}${page.url}`);
            const blocks = response.ok ? blocksFromPage(await response.text()) : [];
            return { url: page.url, title: page.title, section: page.section, blurb: page.blurb, blocks };
        }),
    ).catch(() => {
        cached = undefined;
        return [];
    });

    return json({ entries: await cached });
};

function json(body: { entries: SearchEntry[] }): Response {
    return new Response(JSON.stringify(body), {
        headers: {
            "content-type": "application/json; charset=utf-8",
            // Content-addressed by deploy, not by request: the index changes only when the docs are rebuilt.
            "cache-control": "public, max-age=3600",
        },
    });
}
