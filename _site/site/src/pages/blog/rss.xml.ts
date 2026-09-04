import type { APIRoute } from "astro";
import { ORG_NAME, SITE_URL } from "@intentic-dev/site-content/site";
import { blogHref, posts } from "../../lib/posts";

/* THE FEED, hand-rolled rather than pulled from `@astrojs/rss`.
 *
 * It is thirty lines and it is the whole dependency: a package to build one XML document is a package to
 * update, audit and hold a lockfile entry for the rest of the site's life. The one genuinely fiddly part of
 * RSS is escaping, and that is `escape` below.
 *
 * DESCRIPTIONS, NOT BODIES. Each item carries the post's own one-line description and a link. A full-text
 * feed would put the whole post on somebody else's site, under their URL, competing with the canonical one —
 * and the reason to have a feed at all is to bring a reader back here. */

const escape = (value: string): string =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

// RFC 822, which is what RSS wants and ISO 8601 is not. Dates are date-only in frontmatter, so every item
// is stamped at midnight UTC: a feed reader sorts by day, which is the resolution a blog publishes at.
const rfc822 = (date: string): string => new Date(`${date}T00:00:00Z`).toUTCString();

export const GET: APIRoute = () => {
    const self = `${SITE_URL}/blog/rss.xml`;
    const items = posts
        .map((post) => {
            const url = `${SITE_URL}${blogHref(post.slug)}`;
            return [
                "        <item>",
                `            <title>${escape(post.frontmatter.title)}</title>`,
                `            <link>${escape(url)}</link>`,
                `            <guid isPermaLink="true">${escape(url)}</guid>`,
                `            <pubDate>${rfc822(post.frontmatter.date)}</pubDate>`,
                `            <description>${escape(post.frontmatter.description)}</description>`,
                "        </item>",
            ].join("\n");
        })
        .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
    <channel>
        <title>${escape(`${ORG_NAME} blog`)}</title>
        <link>${SITE_URL}/blog/</link>
        <description>What we have worked out about running a fleet of coding agents, and what we got wrong on the way.</description>
        <language>en-us</language>
        <atom:link href="${self}" rel="self" type="application/rss+xml" />
${items}
    </channel>
</rss>
`;

    return new Response(xml, { headers: { "content-type": "application/rss+xml; charset=utf-8" } });
};
