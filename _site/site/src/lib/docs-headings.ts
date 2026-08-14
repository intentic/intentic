/* Section anchors and the "On this page" list, derived from the page's own rendered HTML.
 *
 * WHY DERIVED AND NOT AUTHORED. Before this, six of the docs site's 148 section headings had an `id`. The other
 * 142 could not be linked to, bookmarked, shared, or jumped to: on pages up to nine screens long, several of
 * which are pure lookup material nobody reads top to bottom. Authoring 142 ids by hand fixes it once and then
 * decays, because the next heading someone writes will not have one and nothing will complain.
 *
 * So DocsLayout renders its slot to a string and passes it through here: every prose heading comes back with a
 * stable id and an anchor control, and the same pass yields the section list the rail renders. A new page gets
 * both for free, and a renamed heading takes its anchor with it.
 *
 * WHICH HEADINGS COUNT. Prose headings are written bare: `<h2>` and `<h3>` with no attributes, while the ones
 * inside card grids and embedded panels carry Tailwind classes. That is the discriminator: a heading with a
 * `class` is furniture inside a component and does not belong in a page's table of contents. A heading that
 * already has an `id` keeps it, because six pages' worth of deep links are already published against those.
 */

export interface DocsHeading {
    /** Anchor target, without the "#". */
    id: string;
    /** Link text: the heading's own words, entities decoded, inline markup stripped. */
    text: string;
    level: 2 | 3;
}

export interface DocsContent {
    /** The same HTML, with ids and anchor controls added to prose headings. */
    html: string;
    /** Every prose heading, in document order. */
    headings: DocsHeading[];
}

/** `<code>api.views</code>: the surfaces` → `api.views: the surfaces` */
function plainText(html: string): string {
    return html
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#(\d+);/g, (_match, code: string) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/**
 * "contributes.processes and contributes.listener" → "contributes-processes-and-contributes-listener"
 *
 * Dots and slashes become hyphens rather than vanishing, so `api.views` and `apiviews` cannot collide, and the
 * result stays readable in a URL bar: a shared link should say which section it points at.
 */
function slugify(text: string): string {
    return (
        text
            .toLowerCase()
            .replace(/['’]/g, "")
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "") || "section"
    );
}

const ANCHOR_LABEL = "Copy link to this section";

/* The anchor control sits INSIDE the heading, after its text, and is invisible until the heading is hovered or
 * the control is focused: a permanent "#" beside every heading is visual noise on a page with twelve of them.
 * It is a real link, so middle-click and "copy link address" work; the click handler that copies it to the
 * clipboard is progressive enhancement on top. */
function anchorMarkup(id: string): string {
    return `<a class="docs-anchor" href="#${id}" aria-label="${ANCHOR_LABEL}" title="${ANCHOR_LABEL}">` + `<span aria-hidden="true">#</span></a>`;
}

/**
 * Fail the build if a `<code>` has swallowed the rest of the page.
 *
 * WHY THIS EXISTS. An Astro expression inside a `<code>` inside a `<table>`, such as `<code>{"{repo}"}</code>`,
 * is the ordinary way to print a literal brace. It makes the compiler emit an opening `<code>` it never closes, just after
 * the table. Every heading, paragraph and table from there to the foot of the page then renders in the monospace
 * face, and the tail of it on the dark code background. It shipped that way on the two longest reference pages,
 * which are the two people arrive at from search with a specific question.
 *
 * It is invisible in the source, invisible in a diff, and the open and close tag counts still balance, so nothing
 * downstream notices. The fix at each site is `<code set:text="{repo}" />`; this is the guard that makes forgetting
 * it loud.
 */
export function assertNoCodeBleed(html: string, pageId: string): void {
    // One pass, tracking how deep we are inside <code>. Cheaper and more honest than a parser: the artifact we are
    // hunting is precisely a depth that never returns to zero.
    let depth = 0;
    const tags = /<(\/?)code[\s>]|<(h[23]|p|table)[\s>]/g;
    for (let match = tags.exec(html); match !== null; match = tags.exec(html)) {
        if (match[2] !== undefined) {
            if (depth > 0) {
                const at = html.slice(Math.max(0, match.index - 120), match.index + 60).replace(/\s+/g, " ");
                throw new Error(
                    `/docs/${pageId}/: a <code> has swallowed the page: <${match[2]}> is rendering as code.\n` +
                        `  An expression inside a <code> inside a <table> does this. Use <code set:text="…" /> there.\n` +
                        `  Near: …${at}…`,
                );
            }
            continue;
        }
        depth += match[1] === "/" ? -1 : 1;
        if (depth < 0) depth = 0;
    }
}

/**
 * Give every prose heading an id and an anchor, and report the headings found.
 *
 * @param html The page's rendered content, from `Astro.slots.render("default")`.
 */
export function extractDocsContent(html: string): DocsContent {
    const headings: DocsHeading[] = [];
    const used = new Set<string>();

    // Attributes are captured so an authored `id` survives and a classed heading can be recognised and skipped.
    const processed = html.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/g, (whole, rawLevel: string, attrs: string, inner: string) => {
        // Furniture inside a card or panel, not a section of this page.
        if (/\sclass=/.test(attrs)) return whole;

        const level = Number(rawLevel) as 2 | 3;
        const text = plainText(inner);
        if (text === "") return whole;

        const authored = /\sid="([^"]*)"/.exec(attrs)?.[1];
        let id = authored ?? slugify(text);
        // Two sections can legitimately share a name across a page; the second gets a suffix so both remain
        // reachable rather than the first silently swallowing the link.
        if (used.has(id)) {
            let suffix = 2;
            while (used.has(`${id}-${suffix}`)) suffix += 1;
            id = `${id}-${suffix}`;
        }
        used.add(id);
        headings.push({ id, text, level });

        const attrsWithId = authored === undefined ? `${attrs} id="${id}"` : attrs;
        return `<h${level}${attrsWithId}>${inner}${anchorMarkup(id)}</h${level}>`;
    });

    return { html: processed, headings };
}
