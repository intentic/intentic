/* WHICH FILES COUNT, AND WHAT A LINE OF ONE IS.
 *
 * Every number this harness reports depends on two boring decisions that are easy to get quietly wrong, so
 * they are made once, here, and nowhere else.
 *
 * WHICH FILES. `git ls-files` against the tree being measured, never a directory walk. A walk picks up
 * `node_modules`, `dist`, build caches and whatever the last test run left behind, and it picks up a DIFFERENT
 * set of those on the two trees you are comparing, which is how a refactor "removes" 40,000 lines that were
 * never source. Tracked files are the same set on both sides by construction.
 *
 * WHAT IS SOURCE. First-party TypeScript, Vue and Node scripts. Not `.d.ts` (generated or hand-written type
 * surface, not code an agent navigates), not fixtures, not snapshots. Tests are LISTED but held separately:
 * they are the workload for the bench and they are excluded from the shape metrics, because "we deleted tests"
 * is not a simplification and must never be able to move the headline number.
 *
 * WHAT A LINE IS. Three counts, always reported together: physical, code, and comment/blank. A refactor that
 * compacts docstrings moves physical lines a long way and code lines hardly at all, and a report that gives
 * only the first is flattering itself. The split is what lets a reader see which one happened. */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".vue", ".mjs", ".js"]);

// Paths that are tracked but are not code anybody navigates. Kept narrow on purpose: every entry here is a
// number somebody could hide a regression behind, so each has to earn its place.
const EXCLUDED = [
    /(^|\/)node_modules\//,
    /(^|\/)dist\//,
    /(^|\/)\.turbo\//,
    /\.d\.m?ts$/,
    /(^|\/)fixtures?\//,
    /(^|\/)__fixtures__\//,
    /(^|\/)__snapshots__\//,
    /(^|\/)generated\//,
    /\.generated\.[a-z]+$/,
];

const TEST_PATTERNS = [
    /\.test\.[cm]?[jt]sx?$/,
    /\.spec\.[cm]?[jt]sx?$/,
    /\.integration\.test\.[cm]?[jt]sx?$/,
    /(^|\/)e2e\//,
    /(^|\/)__tests__\//,
    /(^|\/)tests?\//,
];

export const isTest = (path) => TEST_PATTERNS.some((pattern) => pattern.test(path));

const extensionOf = (path) => {
    const dot = path.lastIndexOf(".");
    return dot === -1 ? "" : path.slice(dot);
};

/* Everything git knows about in a tree, unfiltered. Source selection filters this down, but workspace import
 * resolution needs the package.json manifests that the filter drops, so the raw list is its own export. */
export const listTracked = (root, ref) => {
    const args = ref ? ["ls-tree", "-r", "--name-only", ref] : ["ls-files"];
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
        .split("\n")
        .filter(Boolean);
};

/* Every tracked file in a tree, split into source and test. `ref` measures a git ref instead of the working
 * tree, which is how a baseline is captured without checking anything out. */
export const listFiles = (root, ref) => {
    const all = listTracked(root, ref);

    const source = [];
    const tests = [];
    for (const path of all) {
        if (!SOURCE_EXTENSIONS.has(extensionOf(path))) {
            continue;
        }
        if (EXCLUDED.some((pattern) => pattern.test(path))) {
            continue;
        }
        (isTest(path) ? tests : source).push(path);
    }
    return { source: source.sort(), tests: tests.sort() };
};

// Reading from a ref rather than the working tree, so a baseline never needs a second checkout.
export const readAt = (root, path, ref) => {
    if (!ref) {
        try {
            return readFileSync(join(root, path), "utf8");
        } catch {
            return "";
        }
    }
    try {
        return execFileSync("git", ["show", `${ref}:${path}`], {
            cwd: root,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
        });
    } catch {
        return "";
    }
};

/* A Vue single-file component's script block. The template and style are real content but they are not what a
 * symbol lookup lands in, and running a TypeScript parser over a template produces noise rather than an error.
 * Returned with the offset so line numbers still refer to the whole file. */
export const vueScript = (text) => {
    const match = /<script\b[^>]*>([\s\S]*?)<\/script>/u.exec(text);
    if (!match) {
        return { code: "", lineOffset: 0 };
    }
    const before = text.slice(0, match.index + match[0].indexOf(match[1]));
    return { code: match[1], lineOffset: before.split("\n").length - 1 };
};

/* Physical / code / comment / blank, for one file. A single pass tracking block-comment state, classifying a
 * line by what it STARTS with — which is how every LOC counter worth trusting does it, and is deliberately not
 * a parse.
 *
 * WHAT IT GETS WRONG, so nobody reads more into these numbers than they hold: a block-comment opener inside a
 * string literal starts a comment it should not, and a line that closes a block and then continues with real
 * code is counted as comment. Both are rare, both round the comment count UP, and rounding up is the safe
 * direction: this number's job is to stop a comment-compacting refactor being reported as a code reduction, so
 * over-counting comments can only make that claim more conservative, never less. */
export const classifyLines = (text) => {
    const lines = text.split("\n");
    let code = 0;
    let comment = 0;
    let blank = 0;
    let inBlock = false;

    for (const raw of lines) {
        const line = raw.trim();
        if (line === "") {
            blank += 1;
            continue;
        }

        if (inBlock) {
            comment += 1;
            if (line.includes("*/")) {
                inBlock = false;
                // Code after the close on the same line makes it a code line too; rare enough to round down.
            }
            continue;
        }

        if (line.startsWith("//")) {
            comment += 1;
            continue;
        }

        if (line.startsWith("/*")) {
            comment += 1;
            if (!line.includes("*/")) {
                inBlock = true;
            }
            continue;
        }

        // A line that OPENS a block comment after real code counts as code, but the block still has to be
        // tracked or every line until the close is miscounted.
        const open = line.lastIndexOf("/*");
        if (open !== -1 && !line.slice(open).includes("*/")) {
            inBlock = true;
        }
        code += 1;
    }

    return { physical: lines.length, code, comment, blank };
};

export const percentile = (sorted, p) => {
    if (sorted.length === 0) {
        return 0;
    }
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[index];
};

export const sum = (values) => values.reduce((total, value) => total + value, 0);
export const mean = (values) => (values.length === 0 ? 0 : sum(values) / values.length);
