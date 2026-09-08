import type { APIRoute } from "astro";
import { ORG_NAME, SITE_URL } from "@intentic/site-content/site";
import { blogHref, posts } from "../../lib/posts";

// Hand-rolled feed, not `@astrojs/rss`: thirty lines is not worth a dependency, and escaping (below) is the only fiddly
// part. Each item carries the post's description and a link, not the full body, so the feed brings readers back here
// rather than hosting the post itself.

const escape = (value: string): string =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

// RFC 822: what RSS wants, not ISO 8601. Frontmatter dates are date-only, so every item is stamped at midnight UTC.
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
