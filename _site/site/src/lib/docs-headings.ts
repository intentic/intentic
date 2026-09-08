// Section anchors and the "On this page" list, derived from the page rendered HTML rather than authored by hand, so a
// new heading always gets one. A bare `<h2>`/`<h3>` (no `class`) is a prose heading; one with `class` is component
// furniture and is skipped. An existing `id` is kept.

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

/** Dots and slashes become hyphens, not gaps, so `api.views` and `apiviews` cannot collide in the resulting slug. */
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

// Anchor sits inside the heading, hidden until hover or focus; a real `<a>` so middle-click and copy-link-address work,
// with a click handler that copies it as enhancement.
function anchorMarkup(id: string): string {
    return `<a class="docs-anchor" href="#${id}" aria-label="${ANCHOR_LABEL}" title="${ANCHOR_LABEL}">` + `<span aria-hidden="true">#</span></a>`;
}

/**
 * Fails the build if an Astro expression inside a `<code>` inside a `<table>` leaves the `<code>` unclosed, silently
 * rendering the rest of the page as code. Fix at the source: `<code set:text="..." />`.
 */
export function assertNoCodeBleed(html: string, pageId: string): void {
    // One pass tracking `<code>` nesting depth; the bug is exactly a depth that never returns to zero.
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
        if (depth < 0) {
            depth = 0;
        }
    }
}

/**
 * Gives every prose heading an id and an anchor; returns the headings found.
 * @param html The page's rendered content, from `Astro.slots.render("default")`.
 */
export function extractDocsContent(html: string): DocsContent {
    const headings: DocsHeading[] = [];
    const used = new Set<string>();

    // Attributes are captured so an authored `id` survives and a classed heading can be recognised and skipped.
    const processed = html.replace(/<h([23])([^>]*)>([\s\S]*?)<\/h\1>/g, (whole, rawLevel: string, attrs: string, inner: string) => {
        // Furniture inside a card or panel, not a section of this page.
        if (/\sclass=/.test(attrs)) {
            return whole;
        }

        const level = Number(rawLevel) as 2 | 3;
        const text = plainText(inner);
        if (text === "") {
            return whole;
        }

        const authored = /\sid="([^"]*)"/.exec(attrs)?.[1];
        let id = authored ?? slugify(text);
        // Two headings can share a name; the second gets a numeric suffix so both stay linkable.
        if (used.has(id)) {
            let suffix = 2;
            while (used.has(`${id}-${suffix}`)) {
                suffix += 1;
            }
            id = `${id}-${suffix}`;
        }
        used.add(id);
        headings.push({ id, text, level });

        const attrsWithId = authored === undefined ? `${attrs} id="${id}"` : attrs;
        return `<h${level}${attrsWithId}>${inner}${anchorMarkup(id)}</h${level}>`;
    });

    return { html: processed, headings };
}
