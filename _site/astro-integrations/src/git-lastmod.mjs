// @ts-check
// Resolves a public URL to its source files and returns the ISO date of their last git commit, for the sitemap's <lastmod>
// and article schema's dateModified. Paths resolve relative to `process.cwd()` (the Astro app being built).
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

/**
 * Return ISO date of the last commit touching any of `relPaths`, or null.
 * @param {string[]} relPaths
 * @returns {string | null}
 */
function gitLastModified(relPaths) {
    // A shallow clone (Cloudflare's build checks out one commit) answers every path with HEAD's date: the sitemap then
    // stamped all ~110 URLs with one timestamp, which teaches a crawler to ignore lastmod. No date beats a wrong one.
    if (isShallow()) {
        return null;
    }
    try {
        const out = execSync(`git log -1 --format=%cI -- ${relPaths.map((relPath) => JSON.stringify(relPath)).join(" ")}`, {
            cwd: projectRoot,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        return out || null;
    } catch {
        return null;
    }
}

/** @type {boolean | undefined} */
let shallow;

/** Whether the checkout is shallow, asked once per build. A git that cannot answer is treated as shallow. */
function isShallow() {
    if (shallow === undefined) {
        try {
            shallow =
                execSync("git rev-parse --is-shallow-repository", { cwd: projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() !==
                "false";
        } catch {
            shallow = true;
        }
    }
    return shallow;
}

/**
 * Routes generated from one content module and a shared `[slug].astro` template: a detail page has no file of its own, so
 * it dates from the template and the module its words come from. Blog posts are one Markdown file each.
 * @type {{ prefix: string; content: (slug: string) => string[] }[]}
 */
const generatedRoutes = [
    { prefix: "/guides", content: () => ["../site-content/src/guides.ts"] },
    { prefix: "/features", content: () => ["../site-content/src/product.ts"] },
    { prefix: "/blog", content: (slug) => [`content/posts/${slug}.md`] },
];

/**
 * Map a public URL pathname to its source file paths.
 * Tries `src/pages/<path>.astro` first, then `src/pages/<path>/index.astro`.
 * Comparison details fall back to their shared template; the hub and details also depend on compare.ts.
 * @param {string} pathname
 * @returns {string[] | null}
 */
function urlPathToSources(pathname) {
    const trimmed = pathname.replace(/\/+$/, "");
    if (trimmed === "") {
        return ["src/pages/index.astro"];
    }
    const comparisonDetail = /^\/compare\/[^/]+$/.test(trimmed);
    const candidates = [`src/pages${trimmed}.astro`, `src/pages${trimmed}/index.astro`];
    if (comparisonDetail) {
        candidates.push("src/pages/compare/[slug].astro");
    }
    for (const c of candidates) {
        if (existsSync(path.join(projectRoot, c))) {
            return trimmed === "/compare" || comparisonDetail ? [c, "../site-content/src/compare.ts"] : [c];
        }
    }
    for (const route of generatedRoutes) {
        const match = new RegExp(`^${route.prefix}/([^/]+)$`, "u").exec(trimmed);
        const template = `src/pages${route.prefix}/[slug].astro`;
        if (match && existsSync(path.join(projectRoot, template))) {
            const sources = route.content(match[1] ?? "").filter((source) => existsSync(path.join(projectRoot, source)));
            return sources.length > 0 ? [template, ...sources] : null;
        }
    }
    return null;
}

/** @type {Map<string, string | null>} */
const cache = new Map();

/**
 * Return ISO lastmod for a sitemap URL, or null if no source file / no git history.
 * @param {string} url
 * @returns {string | null}
 */
export function lastModForUrl(url) {
    if (cache.has(url)) {
        return cache.get(url) ?? null;
    }
    const u = new URL(url);
    const sources = urlPathToSources(u.pathname);
    if (!sources) {
        cache.set(url, null);
        return null;
    }
    const date = gitLastModified(sources);
    cache.set(url, date);
    return date;
}
