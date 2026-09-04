import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/* The published posts' slugs, for the Astro CONFIG, which is the one consumer that cannot ask `posts.ts`.
 *
 * `src/lib/posts.ts` reads the same directory with `import.meta.glob`, which is a Vite transform applied to
 * the module graph of the site — and the config is loaded before that graph exists. So this reads the files
 * off disk instead. It is deliberately the smallest thing that can answer the question: which posts will be
 * built, in what order. Everything else about a post — its title, its description, the fact that a missing
 * one is a build error — stays in `posts.ts`, which is where the pages read it from.
 *
 * The one rule duplicated here is `draft: true`, and the reason it must be is that a draft has no page, so
 * naming it in llms.txt would point a machine reader at a 404. */

const postsDir = fileURLToPath(new URL("../content/posts", import.meta.url));

/** Frontmatter's `draft: true`, and nothing subtler. A draft is a flag, not an expression. */
const isDraft = (source) => /^---[\s\S]*?^draft:\s*true\s*$[\s\S]*?^---/mu.test(source);

/** Frontmatter's `date:`, which is what the shelf sorts on. Missing dates sort last and fail in `posts.ts`. */
const dateOf = (source) => /^---[\s\S]*?^date:\s*"?(?<date>\d{4}-\d{2}-\d{2})"?[\s\S]*?^---/mu.exec(source)?.groups?.date ?? "";

/** `/blog/<slug>/` for every published post, newest first: the same order the index page renders. */
export function postPaths() {
    if (!existsSync(postsDir)) {
        return [];
    }
    return readdirSync(postsDir)
        .filter((file) => file.endsWith(".md"))
        .map((file) => ({ slug: file.replace(/\.md$/u, ""), source: readFileSync(path.join(postsDir, file), "utf8") }))
        .filter((post) => !isDraft(post.source))
        .sort((a, b) => dateOf(b.source).localeCompare(dateOf(a.source)))
        .map((post) => `/blog/${post.slug}/`);
}
