// Files are `git ls-files` in the tree, never a directory walk, so both sides of a comparison see the same set. Source
// is first-party TS/Vue/Node script, excluding `.d.ts`, fixtures and snapshots; tests are listed but held out of the
// shape metrics. Every count reports physical, code, and comment/blank lines together.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SOURCE_EXTENSIONS = new Set([".ts", ".mts", ".cts", ".tsx", ".vue", ".mjs", ".js"]);

// Tracked paths that are not navigable code; kept narrow.
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

// All git-tracked paths in a tree, unfiltered; workspace import resolution needs the package.json manifests that source
// filtering drops.
export const listTracked = (root, ref) => {
    const args = ref ? ["ls-tree", "-r", "--name-only", ref] : ["ls-files"];
    return execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 })
        .split("\n")
        .filter(Boolean);
};

// Splits tracked files into source and test. `ref` reads a git ref instead of the working tree, for a baseline without
// checkout.
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

// Extracts a Vue SFC's `<script>` block; a TS parser run over the template produces noise, not an error. Includes
// `lineOffset` so line numbers still refer to the whole file.
export const vueScript = (text) => {
    const match = /<script\b[^>]*>([\s\S]*?)<\/script>/u.exec(text);
    if (!match) {
        return { code: "", lineOffset: 0 };
    }
    const before = text.slice(0, match.index + match[0].indexOf(match[1]));
    return { code: match[1], lineOffset: before.split("\n").length - 1 };
};

// Classifies each line as code, comment or blank by what it starts with, not a parse; edge cases (a marker inside a
// string, code after a closing `*/`) always round toward comment, never under it.
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

        // Opening a block comment still counts the line as code; `inBlock` must still flip or later lines miscount.
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
