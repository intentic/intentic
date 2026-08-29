// @ts-check
// Resolve a public URL to its source page and return the ISO date of the last
// git commit touching it: used to populate <lastmod> in the sitemap and the
// dateModified of article schemas. Paths resolve relative to `process.cwd()`
// (the Astro app being built).
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();

/** Return ISO date of the last commit touching `relPath`, or null. */
function gitLastModified(relPath) {
    try {
        const out = execSync(`git log -1 --format=%cI -- ${JSON.stringify(relPath)}`, {
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
 * Map a public URL pathname to the most likely source file path.
 * Tries `src/pages/<path>.astro` first, then `src/pages/<path>/index.astro`.
 */
function urlPathToSource(pathname) {
    const trimmed = pathname.replace(/\/+$/, "");
    if (trimmed === "") {
        return "src/pages/index.astro";
    }
    const candidates = [`src/pages${trimmed}.astro`, `src/pages${trimmed}/index.astro`];
    for (const c of candidates) {
        if (existsSync(path.join(projectRoot, c))) {
            return c;
        }
    }
    return null;
}

const cache = new Map();

/** Return ISO lastmod for a sitemap URL, or null if no source file / no git history. */
export function lastModForUrl(url) {
    if (cache.has(url)) {
        return cache.get(url);
    }
    const u = new URL(url);
    const src = urlPathToSource(u.pathname);
    if (!src) {
        cache.set(url, null);
        return null;
    }
    const date = gitLastModified(src);
    cache.set(url, date);
    return date;
}
