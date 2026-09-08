import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Published posts' slugs, for astro.config, which can't use `posts.ts`'s `import.meta.glob` (not built yet when config
// loads); reads the directory directly instead. Only which posts build and in what order; everything else stays in
// `posts.ts`. Duplicates `draft: true`, since a draft has no page and would 404 in llms.txt.

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
