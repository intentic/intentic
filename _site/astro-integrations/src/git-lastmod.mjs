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
