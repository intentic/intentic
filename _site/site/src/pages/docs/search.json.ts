import { blocksFromPage, type SearchEntry } from "@intentic-dev/astro-integrations";
import { docsHref, docsPlacements } from "@intentic-dev/site-content/docs";
import type { APIRoute } from "astro";

/* The docs search index — this route serves it under `astro dev`; the build writes it from dist.
 *
 * WHY THERE WAS NO SEARCH: twenty pages, one of them a forty-row route table, and the only way in was guessing
 * which shelf held the word you wanted. Someone who knows they need "webhook" should not have to know whether
 * that lives under automations, the HTTP API, or the doorbell guide. (It is all three.)
 *
 * WHERE THE TEXT COMES FROM. The pages as they render, never their source. This route used to scrape the .astro
 * files with regexes, which could not see a table — and every long reference table here is `{rows.map(...)}` over
 * an array in the frontmatter, so 90 of the docs' 235 rows were missing from the index while fragments of page
 * source leaked into the previews. See docs-search.mjs for the full account.
 *
 * In dev there is no dist to read, so this asks the dev server for each page over HTTP and runs the build's own
 * extractor over the answer. One index, one extractor, same behaviour in both — which is the reason this route
 * still exists rather than the build owning search outright.
 */

const pages = docsPlacements.map(({ page, section }) => ({
    id: page.id,
    url: docsHref(page.id),
    title: page.title,
    section: section.label,
    blurb: page.blurb,
}));

// One fetch of the corpus per dev server, not per search: the reader edits a page and reloads, which re-runs this
// module. Within one run the pages cannot change under us.
let cached: Promise<SearchEntry[]> | undefined;

export const GET: APIRoute = async ({ request }) => {
    /* A build reaches this too, and there is nothing to ask: the pages are being written as we run. It answers
     * empty and the docsSearch integration overwrites this file at astro:build:done, from the built HTML. */
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
