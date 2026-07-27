import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createIgnoreScope, type IgnoreScope } from "@intentic/workspace-ignore";
import type { FileClass, FileEntry, Scope } from "../types.js";
import { isIqDenied } from "./floor.js";
import { globToRegExp } from "./glob.js";

// Runaway guard, far above any real workspace (the tree route caps at 5k entries).
const MAX_FILES = 100_000;

// Stat-sweep the workspace: every file the ignore model admits, sorted by path for determinism. This list is the
// single authority on what any engine may surface — ripgrep/git results are post-filtered against it.
export const sweep = async (root: string, includeIgnored: boolean): Promise<FileEntry[]> => {
    const entries: FileEntry[] = [];
    const walk = async (dir: string, rel: string, scope: IgnoreScope, repo: string | undefined): Promise<void> => {
        const here = await scope.descend(dir, rel);
        const dirents = await readdir(dir, { withFileTypes: true }).catch(() => []);
        const ownsGit = dirents.some((d) => d.name === ".git" && d.isDirectory());
        const repoHere = ownsGit ? rel : repo;
        for (const dirent of dirents.toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
            if (dirent.isSymbolicLink()) {
                continue;
            }
            const relPath = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
            if (isIqDenied(relPath) || (!includeIgnored && here.isIgnored(dirent.name, relPath, dirent.isDirectory()))) {
                continue;
            }
            if (dirent.isDirectory()) {
                await walk(join(dir, dirent.name), relPath, here, repoHere);
                continue;
            }
            if (!dirent.isFile() || entries.length >= MAX_FILES) {
                continue;
            }
            const stats = await stat(join(dir, dirent.name)).catch(() => undefined);
            if (stats === undefined) {
                continue;
            }
            entries.push({
                path: relPath,
                abs: join(dir, dirent.name),
                mtimeMs: stats.mtimeMs,
                size: stats.size,
                ...(repoHere !== undefined ? { repo: repoHere } : {}),
            });
        }
    };
    await walk(root, "", createIgnoreScope(), undefined);
    return entries.toSorted((a, b) => (a.path < b.path ? -1 : 1));
};

const CLASS_TESTS = /(^|\/)((__tests__|tests?)\/|test_[^/]*$)|\.(test|spec)\.[^/.]+$/;
const CLASS_DOCS = /(^|\/)(docs?\/)|\.(md|mdx|rst|txt)$/i;
const CLASS_CONFIG = /(^|\/)[^/]*\.(json|jsonc|ya?ml|toml|ini)$|(^|\/)\.[^/]*rc[^/]*$|(^|\/)[^/]*\.config\.[^/.]+$/;

const matchesClass = (path: string, cls: FileClass): boolean => {
    if (cls === "tests") {
        return CLASS_TESTS.test(path);
    }
    if (cls === "docs") {
        return CLASS_DOCS.test(path);
    }
    if (cls === "config") {
        return CLASS_CONFIG.test(path);
    }
    return !CLASS_TESTS.test(path) && !CLASS_DOCS.test(path) && !CLASS_CONFIG.test(path);
};

const EXT_LANG: Record<string, string> = {
    ts: "ts",
    tsx: "tsx",
    mts: "ts",
    cts: "ts",
    js: "js",
    jsx: "js",
    mjs: "js",
    cjs: "js",
    py: "python",
    go: "go",
    rs: "rust",
    java: "java",
    // No ast-grep grammar of its own — symbol extraction lifts the <script> block and parses it as TypeScript
    // (indexer/sfc.ts). Named here so `--lang vue` scopes and the "no X files in scope" diagnostic can say it.
    vue: "vue",
};

export const langOf = (path: string): string | undefined => EXT_LANG[path.slice(path.lastIndexOf(".") + 1)];

const LANG_NAMES = new Set(Object.values(EXT_LANG));

// Accepts extensions AND canonical names ("py" or "python") — user-facing lang tokens must never silently
// mismatch the canonical values langOf() produces (benchmarked: "--lang py" used to filter out every .py file).
export const canonicalLang = (token: string): string | undefined => EXT_LANG[token] ?? (LANG_NAMES.has(token) ? token : undefined);

// Narrow the sweep to the request's scope. Pure path logic — the security floor already happened in the sweep.
export const filterScope = (entries: readonly FileEntry[], scope: Scope): FileEntry[] => {
    const globs = scope.globs?.map(globToRegExp);
    const notGlobs = scope.notGlobs?.map(globToRegExp);
    const prefixes = scope.paths?.map((p) => p.replace(/^\.\//, "").replace(/\/+$/, ""));
    const langs = scope.langs?.map((token) => canonicalLang(token) ?? token);
    return entries.filter((entry) => {
        if (prefixes !== undefined && !prefixes.some((p) => entry.path === p || entry.path.startsWith(`${p}/`))) {
            return false;
        }
        if (scope.repo !== undefined && entry.repo !== scope.repo) {
            return false;
        }
        if (langs !== undefined && !langs.includes(langOf(entry.path) ?? "")) {
            return false;
        }
        if (globs !== undefined && !globs.some((g) => g.test(entry.path))) {
            return false;
        }
        if (notGlobs?.some((g) => g.test(entry.path))) {
            return false;
        }
        if (scope.only !== undefined && !matchesClass(entry.path, scope.only)) {
            return false;
        }
        return true;
    });
};
