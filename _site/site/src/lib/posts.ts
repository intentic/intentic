import type { MarkdownInstance } from "astro";

// Blog posts, read at build from `content/posts/*.md`; markdown, not a typed `site-content` object, since a post has no
// shape to enforce. Built like every other page (sitemap, `.md` mirror, llms.txt, OpenGraph); publishing costs a
// deploy. The filename is the slug; the date lives in frontmatter, not the URL.

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

// What the file says before normalising: `date: 2026-09-04` unquoted is a YAML timestamp (parsed as `Date`); quoted, it
// is a string. Both are valid YAML, so both are accepted.
type RawFrontmatter = Omit<PostFrontmatter, "date"> & { date: string | Date };

export interface Post {
    slug: string;
    frontmatter: PostFrontmatter;
    /** The compiled body, rendered by the post page. */
    Content: MarkdownInstance<PostFrontmatter>["Content"];
}

export const blogHref = (slug: string): string => (slug ? `/blog/${slug}/` : "/blog/");

// Eager: the index, feed and route table all need every post before building any one page.
const modules = import.meta.glob<MarkdownInstance<RawFrontmatter>>("../../content/posts/*.md", { eager: true });

const slugOf = (path: string): string => path.split("/").pop()!.replace(/\.md$/u, "");

// Frontmatter date as `YYYY-MM-DD`, from a `Date`, an ISO string, or the string as typed; unquoted YAML reads a bare
// date as a timestamp. The time half is always midnight and is dropped.
const isoDay = (date: string | Date): string => {
    if (date instanceof Date) {
        return Number.isNaN(date.getTime()) ? "" : date.toISOString().slice(0, 10);
    }
    return typeof date === "string" ? date.trim().slice(0, 10) : "";
};

// A missing `title`/`description`/`date` is a build error, not a default: the site's own fallback would silently reach
// a sitemap URL, the same failure page-meta.ts guards elsewhere.
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
