import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { errnoCode, errorMessage, isMissing } from "@intentic/base/errors";
import { createIgnoreScope, type IgnoreScope } from "@intentic/workspace-ignore";
import type { FileClass, FileEntry, Scope } from "../types.js";
import { isIqDenied } from "./floor.js";
import { globToRegExp } from "./glob.js";
import { withShadows } from "./shadows.js";

// Runaway guard, well above any real workspace; the tree route caps at 5k entries.
const MAX_FILES = 100_000;

export interface Sweep {
    readonly entries: FileEntry[];
    // `path (CODE)` per directory or file the walk could not read; nothing under one is in `entries`, so no engine
    // can see it. A path that vanished mid-walk is a race with a writer, not listed.
    readonly unreadable: string[];
}

// Stat-sweeps every file the ignore model admits, sorted by path for determinism; the single authority engines filter
// ripgrep/git results against. Walked and stat'd concurrently; the sort keeps output order-independent.
export const sweep = async (root: string, includeIgnored: boolean): Promise<Sweep> => {
    const entries: FileEntry[] = [];
    const unreadable: string[] = [];
    const skip = (relPath: string, error: unknown): undefined => {
        if (!isMissing(error)) {
            unreadable.push(`${relPath} (${errnoCode(error) ?? errorMessage(error)})`);
        }
        return undefined;
    };
    const walk = async (dir: string, rel: string, scope: IgnoreScope, repo: string | undefined): Promise<void> => {
        const here = await scope.descend(dir, rel).catch((error: unknown) => {
            // Its ignore rules unknown, nothing under it is admitted: an ignored file must never read as tracked.
            if (rel === "") {
                throw error;
            }
            skip(`${rel}/.gitignore`, error);
            return undefined;
        });
        if (here === undefined) {
            return;
        }
        const dirents = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => {
            // An unreadable root is no sweep at all, never an empty one.
            if (rel === "") {
                throw error;
            }
            skip(rel, error);
            return [];
        });
        // A `.git` file marks a repo boundary same as a `.git` dir: worktrees, submodules, --separate-git-dir.
        const ownsGit = dirents.some((d) => d.name === ".git");
        const repoHere = ownsGit ? rel : repo;
        await Promise.all(
            dirents.map(async (dirent) => {
                if (dirent.isSymbolicLink()) {
                    return;
                }
                const relPath = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
                // A `.git` pointer file is ignored like a `.git` dir, only here since a portability bundle must still
                // carry it.
                const junkGit = dirent.isDirectory() || dirent.name === ".git";
                if (isIqDenied(relPath) || (!includeIgnored && here.isIgnored(dirent.name, relPath, junkGit))) {
                    return;
                }
                if (dirent.isDirectory()) {
                    await walk(join(dir, dirent.name), relPath, here, repoHere);
                    return;
                }
                if (!dirent.isFile() || entries.length >= MAX_FILES) {
                    return;
                }
                const stats = await stat(join(dir, dirent.name)).catch((error: unknown) => skip(relPath, error));
                if (stats === undefined) {
                    return;
                }
                entries.push({
                    path: relPath,
                    abs: join(dir, dirent.name),
                    mtimeMs: stats.mtimeMs,
                    size: stats.size,
                    ...(repoHere !== undefined ? { repo: repoHere } : {}),
                });
            }),
        );
    };
    await walk(root, "", createIgnoreScope(), undefined);
    // Re-applied here: concurrent pushes can overshoot MAX_FILES; the sorted prefix is the slice kept. Documents with a
    // shadow then point at it, so every engine reads a pdf's text rather than its bytes.
    const kept = entries.toSorted((a, b) => (a.path < b.path ? -1 : 1)).slice(0, MAX_FILES);
    return { entries: await withShadows(root, kept), unreadable: unreadable.toSorted() };
};

// The sweep `--ignored` reads (node_modules and build output in, the floor still holding), kept for a moment. Quick-open
// and the search box ask it on every keystroke once "include ignored" is on, and walking 100,000 files into node_modules
// cost 2.8 s on this sandbox's /work (measured 2026-10-26), paid again for each character. Kept per root until the index
// applies a change (a new generation) or WIDE_SWEEP_MS passes, so a fresh install under an ignored folder shows up
// within it.
const WIDE_SWEEP_MS = 30_000;
const wideSweeps = new Map<string, { readonly at: number; readonly generation: number; readonly sweep: Promise<Sweep> }>();

export const wideSweep = (root: string, generation: number, now: number = Date.now()): Promise<Sweep> => {
    const held = wideSweeps.get(root);
    if (held !== undefined && held.generation === generation && now - held.at < WIDE_SWEEP_MS) {
        return held.sweep;
    }
    const fresh = sweep(root, true);
    wideSweeps.set(root, { at: now, generation, sweep: fresh });
    // A walk that failed is not kept: the next ask walks again rather than repeating the failure for the whole window.
    fresh.catch(() => {
        if (wideSweeps.get(root)?.sweep === fresh) {
            wideSweeps.delete(root);
        }
    });
    return fresh;
};

const CLASS_TESTS = /(^|\/)((__tests__|tests?)\/|test_[^/]*$)|\.(test|spec)\.[^/.]+$/;
// Documents (pdf, docx, …, searched through their shadows) are prose like a README: the docs prior, wherever they sit.
const CLASS_DOCS = /(^|\/)(docs?\/)|\.(md|mdx|rst|txt|pdf|docx|xlsx|pptx|odt|ott|ods|ots|odp|otp|odg|rtf|epub)$/i;
const CLASS_CONFIG = /(^|\/)[^/]*\.(json|jsonc|ya?ml|toml|ini)$|(^|\/)\.[^/]*rc[^/]*$|(^|\/)[^/]*\.config\.[^/.]+$/;

// Which of the four `--only` buckets a path falls in, as a total function so ranking can prefer implementation over
// tests and docs without a second set of patterns.
export const classOf = (path: string): FileClass => {
    if (CLASS_TESTS.test(path)) {
        return "tests";
    }
    if (CLASS_DOCS.test(path)) {
        return "docs";
    }
    if (CLASS_CONFIG.test(path)) {
        return "config";
    }
    return "src";
};

const matchesClass = (path: string, cls: FileClass): boolean => classOf(path) === cls;

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
    // No ast-grep grammar of its own; symbol extraction lifts the <script> block and parses it as TypeScript.
    vue: "vue",
};

export const langOf = (path: string): string | undefined => EXT_LANG[path.slice(path.lastIndexOf(".") + 1)];

const LANG_NAMES = new Set(Object.values(EXT_LANG));

// Accepts both extensions and canonical names ("py" or "python"); a user-facing lang token must resolve to what
// langOf() produces.
export const canonicalLang = (token: string): string | undefined => EXT_LANG[token] ?? (LANG_NAMES.has(token) ? token : undefined);

// Narrows swept entries to the request's scope; pure path logic, the security floor already ran in the sweep.
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
