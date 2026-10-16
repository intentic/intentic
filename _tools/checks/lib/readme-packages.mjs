// The packages `intentic-docs validate` expects a README.md of, found by its own rules, and what it reads off one. The
// CLI lives outside this repository (the documentation extension) and is absent in CI, so package-readmes.mjs asks
// the same question here; package-readmes.test.mjs runs the CLI where it exists and holds the two answers equal.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

// A directory holding one of these is a package.
const MANIFESTS = new Set(["package.json", "Cargo.toml", "pyproject.toml", "go.mod"]);
// Never entered: build output and dependency trees.
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "target", ".cache", ".next", "coverage", "vendor", "__pycache__"]);
// A fixture directory belongs to its parent package and is never one itself.
const NON_PACKAGE_SEGMENTS = new Set(["__fixtures__", "__mocks__", "__snapshots__", "__tests__", "fixtures", "test", "tests", "spec"]);
// How far below the repository root a package may sit.
const MAX_DEPTH = 5;

// Every package directory under `repoRoot`, repo-relative and sorted. A nested repository (a directory with `.git`)
// owns its own packages and is not entered.
export const discoverPackages = (repoRoot) => {
    const found = [];
    const walk = (dir, depth) => {
        if (depth > MAX_DEPTH) {
            return;
        }
        const entries = readdirSync(dir, { withFileTypes: true });
        const candidate = relative(repoRoot, dir).split("\\").join("/");
        const isFixture = candidate.split("/").some((segment) => NON_PACKAGE_SEGMENTS.has(segment));
        if (dir !== repoRoot && !isFixture && entries.some((entry) => entry.isFile() && MANIFESTS.has(entry.name))) {
            found.push(candidate);
        }
        for (const entry of entries) {
            if (entry.isDirectory() && !SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".") && !existsSync(join(dir, entry.name, ".git"))) {
                walk(join(dir, entry.name), depth + 1);
            }
        }
    };
    walk(repoRoot, 0);
    return found.toSorted();
};

const MARKUP = (text) =>
    text
        .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/[*_`]+/g, "")
        .replace(/\s+/g, " ")
        .trim();

const isBlockStart = (line) => /^#{1,6}\s/.test(line) || line.startsWith(">") || /^[-*+]\s/.test(line) || line.startsWith("|");

// The prose paragraph directly under the page's H1, as the CLI reads the one-liner; undefined when the page has no H1
// or a heading comes before any prose.
const leadParagraph = (markdown) => {
    const lines = markdown.split(/\r?\n/);
    const start = lines.findIndex((line) => /^#\s+\S/.test(line));
    if (start === -1) {
        return undefined;
    }
    const paragraph = [];
    let fenced = false;
    for (const line of lines.slice(start + 1)) {
        if (line.startsWith("```")) {
            fenced = !fenced;
            continue;
        }
        const trimmed = line.trim();
        if (fenced || (trimmed === "" && paragraph.length === 0)) {
            continue;
        }
        if (trimmed === "" || (isBlockStart(trimmed) && paragraph.length > 0)) {
            break;
        }
        if (/^#{1,6}\s/.test(trimmed)) {
            return undefined;
        }
        if (!isBlockStart(trimmed)) {
            paragraph.push(trimmed);
        }
    }
    const prose = MARKUP(paragraph.join(" "));
    return prose === "" ? undefined : prose;
};

// What is wrong with `dir`'s README, or undefined: `missing`, `no-h1`, or `no-lead`.
export const readmeProblem = (repoRoot, dir) => {
    const path = join(repoRoot, dir, "README.md");
    if (!existsSync(path)) {
        return "missing";
    }
    const markdown = readFileSync(path, "utf8");
    if (!/^#\s+\S/m.test(markdown)) {
        return "no-h1";
    }
    return leadParagraph(markdown) === undefined ? "no-lead" : undefined;
};
