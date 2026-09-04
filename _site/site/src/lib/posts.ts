import type { MarkdownInstance } from "astro";

/* THE BLOG'S POSTS, read at BUILD from `content/posts/*.md`.
 *
 * MARKDOWN, not TypeScript, and it is the one shelf on this site that is. Every other page's words are a
 * typed object in `site-content` — which is right for copy that has a shape (a comparison has rows, a guide
 * has options, a feature page has a hero), because the type is what stops a page shipping half-filled. A
 * post has no shape. It is a title, a date and some prose, and expressing that as a TypeScript object buys
 * nothing and costs whoever writes the next one a build error over a smart quote.
 *
 * So posts are the only content here somebody can add by writing a file, and the frontmatter below is the
 * whole contract. A post is a BUILT page like every other: it gets a sitemap entry with a real lastmod, a
 * `.md` mirror, a line in llms.txt, its own OpenGraph card and BlogPosting structured data. None of that is
 * available to a page fetched at runtime, which is exactly why the blog is not on the live lane that the
 * notice strip and the download switch are on. Publishing a post costs a deploy, and should.
 *
 * THE FILENAME IS THE SLUG. `content/posts/agents-in-parallel.md` is `/blog/agents-in-parallel/`. The date
 * lives in frontmatter rather than in a filename prefix: a URL that carries a date ages the post every time
 * somebody reads the address bar, and it cannot be corrected later without breaking the link. */

export interface PostFrontmatter {
    /** The <h1> and the <title>. Written as the thing somebody would search for, not as a headline. */
    title: string;
    /** The meta description and the card's blurb. Under 160 characters, or a search result truncates it. */
    description: string;
    /** `YYYY-MM-DD`, always, whatever the file wrote. The day it went up; `dateModified` comes from git. */
    date: string;
    /** Optional one-word shelf labels. Rendered, not indexed: there are no tag pages and no plan for them. */
    tags?: string[];
    /** True ⇒ built by nobody: excluded from the index, the feed, the sitemap and the routes entirely. */
    draft?: boolean;
}

/* What the FILE says, before normalising. `date: 2026-09-04` unquoted is a YAML timestamp, so the markdown
 * pipeline hands over a Date; quoted, it is a string. Both spellings are correct YAML and both are what
 * somebody writing a post will type, so the parser takes either rather than the file having to know. */
type RawFrontmatter = Omit<PostFrontmatter, "date"> & { date: string | Date };

export interface Post {
    slug: string;
    frontmatter: PostFrontmatter;
    /** The compiled body, rendered by the post page. */
    Content: MarkdownInstance<PostFrontmatter>["Content"];
}

export const blogHref = (slug: string): string => (slug ? `/blog/${slug}/` : "/blog/");

/* Eager, because every consumer needs every post: the index lists them, the feed serialises them, and the
 * route table has to know the whole set before it can build one page. A lazy glob would be three passes over
 * the same files for no benefit at build time, where nothing is downloaded on demand. */
const modules = import.meta.glob<MarkdownInstance<RawFrontmatter>>("../../content/posts/*.md", { eager: true });

const slugOf = (path: string): string => path.split("/").pop()!.replace(/\.md$/u, "");

/* A frontmatter date as `YYYY-MM-DD`, from any of the three shapes it legitimately arrives in. Unquoted,
 * YAML reads `2026-09-04` as a timestamp and the markdown pipeline hands over either the Date itself or the
 * ISO string it serialises to, depending on whether the frontmatter crossed a build boundary on the way.
 * Quoted, it stays the string somebody typed. All three mean the same day, so all three are accepted and the
 * time half — which is always midnight, and never meant anything — is dropped. */
const isoDay = (date: string | Date): string => {
    if (date instanceof Date) {
        return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
    }
    return typeof date === "string" ? date.trim().slice(0, 10) : "";
};

/* A missing field is a BUILD ERROR rather than a default, and this is the one place on this shelf that is
 * strict. Everything a post needs is three lines of frontmatter; a post that shipped without a description
 * would inherit the site's, on a URL the sitemap is handing to crawlers — the same failure page-meta.ts
 * turned into an error for every other page, arriving by a different door. */
const validate = (slug: string, raw: RawFrontmatter): PostFrontmatter => {
    for (const field of ["title", "description"] as const) {
        if (typeof raw[field] !== "string" || raw[field].trim() === "") {
            throw new Error(`Post content/posts/${slug}.md has no \`${field}\` in its frontmatter. Every post needs title, description and date.`);
        }
    }
    const date = isoDay(raw.date);
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) {
        throw new Error(`Post content/posts/${slug}.md has no usable \`date\`. Write it as YYYY-MM-DD.`);
    }
    return { ...raw, date };
};

/** Every published post, newest first. Drafts are not here, so nothing downstream has to remember them. */
export const posts: Post[] = Object.entries(modules)
    .map(([path, module]) => {
        const slug = slugOf(path);
        return { slug, frontmatter: validate(slug, module.frontmatter), Content: module.Content };
    })
    .filter((post) => post.frontmatter.draft !== true)
    .sort((a, b) => b.frontmatter.date.localeCompare(a.frontmatter.date));

/** How the date reads on the page and in the index: "4 September 2026", the same everywhere. */
export const formatPostDate = (date: string): string =>
    new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
