import { copyFile, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join, matchesGlob } from "node:path";
import type { GitRunner } from "@intentic/base/git";
import { errorMessage, undefinedIfMissing } from "@intentic/base/errors";
import type { Logger } from "pino";
import { REGENERABLE_DIRS } from "./local-files.js";

/* A REPOSITORY'S `.worktreeinclude` (2026-11-24). A conversation's checkout starts with the tracked files and the
 * mirrored dependency dirs (isolation.ts MIRRORED_DIRS), so the ignored files a project needs to run (an `.env`, a local
 * config) are missing. A repository may name them in a `.worktreeinclude` at its root, gitignore-style, as Claude Code
 * and other worktree tools read the same file: each git-ignored file of the main checkout that a line matches is copied
 * into a new checkout. Only ignored files (a tracked one is already there, an untracked one is the owner's work in
 * progress), never a path with `..` or one outside the checkout's fence, within a size budget. Every problem is a warning
 * in the log, never a failed checkout. A copy left unchanged is identical to the main checkout's, so the removal scan
 * (local-files.ts) passes it over. Orca: src/main/git/worktrees/content-paths/worktree-include-file.ts. */

const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

export interface IncludeLimits {
    readonly maxBytes: number;
    readonly maxFiles: number;
    // Directory entries walked looking for matches below a wholly ignored directory.
    readonly maxWalk: number;
}

const DEFAULT_INCLUDE_LIMITS: IncludeLimits = { maxBytes: 64 * 1024 * 1024, maxFiles: 500, maxWalk: 5_000 };

interface Pattern {
    readonly glob: string;
    readonly negated: boolean;
    readonly dirOnly: boolean;
}

// One line of the file as a glob over checkout-relative paths, or a reason it was refused. Gitignore's rules: a slash
// at the start or in the middle anchors the line at the root, otherwise it matches at any depth; a trailing slash matches
// directories only; `!` re-includes nothing here but excludes what an earlier line named.
export const parseIncludeLine = (raw: string): Pattern | { readonly refused: string } | undefined => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) {
        return undefined;
    }
    const negated = line.startsWith("!");
    let body = negated ? line.slice(1) : line;
    if (body.split("/").includes("..") || body.startsWith("~") || /^[A-Za-z]:[\\/]/u.test(body) || body.includes("\\")) {
        return { refused: `"${line}" reaches outside the repository` };
    }
    const dirOnly = body.endsWith("/");
    body = body.replace(/\/+$/u, "");
    const anchored = body.startsWith("/") || body.includes("/");
    body = body.replace(/^\/+/u, "");
    if (body === "") {
        return { refused: `"${line}" names nothing` };
    }
    return { glob: anchored ? body : `**/${body}`, negated, dirOnly };
};

// Whether the path, or a directory above it, is named by the patterns; the last matching line wins, as in gitignore.
const included = (patterns: readonly Pattern[], rel: string): boolean => {
    const parts = rel.split("/");
    let verdict = false;
    for (const pattern of patterns) {
        for (let depth = 1; depth <= parts.length; depth += 1) {
            const isDir = depth < parts.length;
            if ((!pattern.dirOnly || isDir) && matchesGlob(parts.slice(0, depth).join("/"), pattern.glob)) {
                verdict = !pattern.negated;
                break;
            }
        }
    }
    return verdict;
};

// Inside the checkout's sparse cone (worktree-cone.ts): its folders, and the root's own files that cone mode always keeps.
const inCone = (cone: readonly string[] | undefined, rel: string): boolean =>
    cone === undefined || !rel.includes("/") || cone.some((folder) => rel === folder || rel.startsWith(`${folder}/`));

export interface IncludeResult {
    readonly copied: readonly string[];
    readonly warnings: readonly string[];
}

const readPatterns = async (target: string, main: string): Promise<{ patterns: Pattern[]; warnings: string[] } | undefined> => {
    // The branch's own file first (tracked, so a conversation may change it), the main checkout's when it is untracked.
    const text =
        (await readFile(join(target, WORKTREE_INCLUDE_FILE), "utf8").catch(undefinedIfMissing)) ??
        (await readFile(join(main, WORKTREE_INCLUDE_FILE), "utf8").catch(undefinedIfMissing));
    if (text === undefined) {
        return undefined;
    }
    const patterns: Pattern[] = [];
    const warnings: string[] = [];
    for (const line of text.split(/\r?\n/u)) {
        const parsed = parseIncludeLine(line);
        if (parsed === undefined) {
            continue;
        }
        if ("refused" in parsed) {
            warnings.push(`${WORKTREE_INCLUDE_FILE}: ${parsed.refused}, skipped`);
        } else {
            patterns.push(parsed);
        }
    }
    return { patterns, warnings };
};

// The main checkout's ignored files the patterns name, walking a wholly ignored directory only as far as the walk budget.
const candidates = async (main: string, git: GitRunner, patterns: readonly Pattern[], limits: IncludeLimits, warnings: string[]): Promise<string[]> => {
    const { stdout } = await git(main, ["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"]);
    const found: string[] = [];
    let walked = 0;
    const visit = async (rel: string): Promise<void> => {
        if (walked >= limits.maxWalk) {
            return;
        }
        walked += 1;
        const info = await lstat(join(main, rel)).catch(undefinedIfMissing);
        if (info?.isFile() === true) {
            if (included(patterns, rel)) {
                found.push(rel);
            }
            return;
        }
        if (info?.isDirectory() !== true) {
            return;
        }
        for (const name of ((await readdir(join(main, rel)).catch(undefinedIfMissing)) ?? []).toSorted()) {
            // Dependency and build output is mirrored or rebuilt, never copied file by file; another repository is its own.
            if (!REGENERABLE_DIRS.has(name) && name !== ".git") {
                await visit(`${rel}/${name}`);
            }
        }
    };
    for (const entry of stdout.split("\0").filter((path) => path !== "")) {
        const rel = entry.replace(/\/$/u, "");
        if (rel.split("/").some((segment) => REGENERABLE_DIRS.has(segment))) {
            continue;
        }
        await visit(rel);
    }
    if (walked >= limits.maxWalk) {
        warnings.push(`${WORKTREE_INCLUDE_FILE}: stopped looking after ${limits.maxWalk} ignored entries, some matches may not have been copied`);
    }
    return found;
};

/** Copies the main checkout's ignored files a repository's `.worktreeinclude` names into a new checkout; never throws. */
const copyWorktreeIncludes = async (
    main: string,
    target: string,
    git: GitRunner,
    cone: readonly string[] | undefined,
    limits: IncludeLimits = DEFAULT_INCLUDE_LIMITS,
): Promise<IncludeResult> => {
    const copied: string[] = [];
    const warnings: string[] = [];
    try {
        const read = await readPatterns(target, main);
        if (read === undefined) {
            return { copied, warnings };
        }
        warnings.push(...read.warnings);
        if (!read.patterns.some((pattern) => !pattern.negated)) {
            return { copied, warnings };
        }
        let bytes = 0;
        for (const rel of await candidates(main, git, read.patterns, limits, warnings)) {
            if (!inCone(cone, rel) || (await lstat(join(target, rel)).catch(undefinedIfMissing)) !== undefined) {
                continue;
            }
            const size = (await lstat(join(main, rel))).size;
            if (copied.length >= limits.maxFiles || bytes + size > limits.maxBytes) {
                warnings.push(`${WORKTREE_INCLUDE_FILE}: ${rel} not copied, past the budget of ${limits.maxFiles} files or ${limits.maxBytes} bytes`);
                continue;
            }
            await mkdir(dirname(join(target, rel)), { recursive: true });
            await copyFile(join(main, rel), join(target, rel));
            bytes += size;
            copied.push(rel);
        }
    } catch (error) {
        warnings.push(`${WORKTREE_INCLUDE_FILE}: copying stopped (${errorMessage(error)})`);
    }
    return { copied, warnings };
};

/** copyWorktreeIncludes, its warnings logged; for worktrees.ts createOne. */
export const includeIntoCheckout = async (
    place: { readonly main: string; readonly target: string; readonly id: string; readonly repo: string; readonly logger: Pick<Logger, "info" | "warn"> },
    git: GitRunner,
    cone: readonly string[] | undefined,
): Promise<void> => {
    const { copied, warnings } = await copyWorktreeIncludes(place.main, place.target, git, cone);
    for (const warning of warnings) {
        place.logger.warn({ id: place.id, repo: place.repo }, `agents: ${warning}`);
    }
    if (copied.length > 0) {
        place.logger.info({ id: place.id, repo: place.repo, copied: copied.length }, "agents: copied the files .worktreeinclude names into a new checkout");
    }
};
