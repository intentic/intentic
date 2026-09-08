#!/usr/bin/env node
// No hand-spelled roots (`/work`, `.intentic`, etc., typed literally in hundreds of places) and no counting depth with
// `../..` from a file's own location, which resolves silently wrong when the file moves. Use
// `repoRoot()`/`packageRoot()` from @intentic/constants/node, or `_tools/scripts/lib/repo-root.sh` in shell.
// Allowed:
// a test's assertion lines (fixtures still go through the constants)
// `join(x, "..")` where x is computed — an operation, not a position claim
// files that cannot import (see MAY_SPELL_A_ROOT below)
// `homedir()`-based `.intentic`, a different directory from the workspace state dir
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";
import { writesBaselines } from "./lib/repo.mjs";

const root = repoRoot(import.meta.url);

// Standing spellings the constants sweep didn't finish are held per file in this baseline: a count may only shrink or
// be deleted, never grow. `--write-baseline` adopts the current findings, for the one occasion that's legitimate.
const BASELINE = join(root, "_tools/checks/baselines/path-literals.json");
const writeBaseline = process.argv.includes("--write-baseline");

// Files allowed to spell a root literally, each for a reason about reach, not taste.
const MAY_SPELL_A_ROOT = new Set([
    `_tools/constants/src/index.ts`, // where the names are defined
    `_tools/constants/src/node.mjs`, // the walker itself
    `_tools/checks/path-literals.mjs`, // this file: the patterns below are the check
    `_tools/scripts/lib/repo-root.sh`, // the shell walker
    `_site/site/public/scripts/connect.sh`, // downloaded and run standalone
    `_site/site/public/scripts/recreate.sh`, // downloaded and run standalone
    `_extensions/documentation/bin/intentic-docs`, // ships as a raw dir on the agent's PATH, no node_modules
    // Copied into a user's project; must stay installable from npm with only its declared dependency.
    `_tools/extension-example/seed/src/notes.ts`,
]);

// Committed build output: the site ships a bundled copy already flagged at its source, so skip the duplicate.
const GENERATED = [`_site/site/public/`, `_site/site/dist/`, `_editor/web/public/ext-shims/`, `_sandbox/sandbox/operator-templates/`];

// A filesystem root spelled out; the trailing boundary excludes HTTP routes sharing the same prefix.
const SPELLED_ROOT = /(["'`])(\/work|\/history|\/opt\/intentic)(\/[^"'`${\n]*)?\1/;

// `/history/...` is also an HTTP route prefix (the snapshot API): recognized by the company it keeps, not the string
// shape, since pointing it at HISTORY_ROOT would let a volume rename silently move the API.
const ROUTE_CONTEXT = /oc\.route\(|\bpath:\s*["'`]\/|sandboxJson|sandboxRequest|app\.(get|post|put|patch|delete)\(|\bfetch\(|\.request\(/;
// The workspace state dir, except where the line is plainly about the user's home.
const SPELLED_STATE = /(["'`])\.intentic(\/[^"'`${\n]*)?\1/;

// A spelled `.intentic/…` here is the stronger form: `statePath()` takes a literal-union type tied to the state table,
// and `${STATE_DIR}/…` would throw that guarantee away. The table's declaring files are exempt, since they are the
// union.
const TYPED_STATE_PATH = /state(?:Rel)?Path\(/;
const STATE_TABLE_FILES = new Set([`_shared/sandbox-contract/src/state/workspace-state.ts`, `_shared/sandbox-contract/src/state/history-state.ts`]);
// Position claims only: `..` counted past the file's own directory, not a single `..` to a sibling.
const COUNTED_JS = [
    /new URL\(\s*(["'`])\.\.\/\.\./,
    /(resolve|join)\(\s*(import\.meta\.dirname|__dirname)\s*,\s*(["'`])\.\.\/\.\./,
    /(resolve|join)\(\s*(import\.meta\.dirname|__dirname)\s*(,\s*(["'`])\.\.\4){2,}/,
    /createRequire\([^)]*\)\(\s*(["'`])\.\.\/\.\./,
    /dirname\(\s*fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)\s*,\s*(["'`])\.\.\/\.\./,
];
const COUNTED_SH = [/dirname "\$0"\)\/\.\.\/\.\./, /\$(DIR|SCRIPT_DIR|ROOT)\/\.\.\/\.\./, /BASH_SOURCE\[0\]\}"\)\/\.\.\/\.\./];

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/;
const TEST = /\.(test|spec)\.[cm]?[jt]sx?$/;
const SHELL = /\.(sh|bash)$/;

// Whether this line is an assertion, or a continuation of one not yet terminated.
const ASSERTS = /\b(expect|assert)\s*\(/;
const isAssertion = (lines, i) => {
    if (ASSERTS.test(lines[i])) {
        return true;
    }
    for (let k = i - 1; k >= 0 && k > i - 12; k--) {
        const s = lines[k].trim();
        if (s === `` || s.startsWith(`*`) || s.startsWith(`//`) || s.startsWith(`/*`)) {
            continue;
        }
        if (ASSERTS.test(s)) {
            return true;
        }
        if (s.endsWith(`;`) || s.endsWith(`{`) || s.endsWith(`}`)) {
            return false;
        }
    }
    return false;
};

const isComment = (line) => {
    const s = line.trim();
    return s.startsWith(`*`) || s.startsWith(`//`) || s.startsWith(`/*`) || s.startsWith(`#`);
};

// Escape hatch for a string that looks like a path but is the text under test (a fixture, a transcript), not a
// location. Per line, with a reason: `// path-literals: content, <why>`, on the line or the one above it.
const CONTENT_PRAGMA = /path-literals: content/;

const tracked = execFileSync(`git`, [`ls-files`, `-z`], { cwd: root, encoding: `utf8`, maxBuffer: 64 * 1024 * 1024 })
    .split(`\0`)
    .filter((path) => path !== ``);

const findings = [];
for (const path of tracked) {
    if (MAY_SPELL_A_ROOT.has(path) || GENERATED.some((prefix) => path.startsWith(prefix))) {
        continue;
    }
    const shell = SHELL.test(path) || path.startsWith(`_site/site/public/scripts/`);
    if (!CODE.test(path) && !shell) {
        continue;
    }
    let lines;
    try {
        lines = readFileSync(`${root}/${path}`, `utf8`).split(`\n`);
    } catch {
        continue; // a symlink to nowhere, or a path removed since `ls-files` answered
    }
    const test = TEST.test(path);
    for (const [i, line] of lines.entries()) {
        if (isComment(line)) {
            continue;
        }
        if (CONTENT_PRAGMA.test(line) || (i > 0 && CONTENT_PRAGMA.test(lines[i - 1]))) {
            continue;
        }
        const at = `${path}:${i + 1}`;
        for (const pattern of shell ? COUNTED_SH : COUNTED_JS) {
            if (pattern.test(line)) {
                findings.push({
                    at,
                    why: shell
                        ? `counts its way to the repo root: source _tools/scripts/lib/repo-root.sh and call repo_root`
                        : `counts its way to a root, use repoRoot()/packageRoot() from @intentic/constants/node`,
                });
                break;
            }
        }
        if (shell) {
            continue; // a shell script has no import to reach the named constants through
        }
        // A test's expectation may spell a root; a fixture still goes through the constants.
        if (test && isAssertion(lines, i)) {
            continue;
        }
        if (SPELLED_ROOT.test(line) && !ROUTE_CONTEXT.test(line)) {
            findings.push({ at, why: `spells a root, import WORKSPACE_ROOT / HISTORY_ROOT / HOST_STATE_ROOT from @intentic/constants` });
        }
        if (SPELLED_STATE.test(line) && !line.includes(`homedir`) && !TYPED_STATE_PATH.test(line) && !STATE_TABLE_FILES.has(path)) {
            findings.push({ at, why: `spells the state dir, import STATE_DIR from @intentic/constants (or use the daemon's statePath())` });
        }
    }
}

// Findings per file, the baseline's unit: a line number shifts with every edit above it.
const perFile = new Map();
for (const { at } of findings) {
    const path = at.slice(0, at.lastIndexOf(":"));
    perFile.set(path, (perFile.get(path) ?? 0) + 1);
}
if (writeBaseline) {
    const sorted = Object.fromEntries([...perFile].sort(([a], [b]) => a.localeCompare(b)));
    writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 4)}\n`);
    console.log(`path-literals: baseline written, ${findings.length} standing findings in ${perFile.size} files`);
    process.exit(0);
}
const baseline = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};

const grown = [];
for (const [path, count] of perFile) {
    const allowed = baseline[path] ?? 0;
    if (count > allowed) {
        grown.push(...findings.filter(({ at }) => at.startsWith(`${path}:`)).map(({ at, why }) => `${at}  ${why}`));
        grown.push(`  ${path}: ${count} spelling(s), the baseline allows ${allowed}`);
    }
}
// A baseline entry the tree has beaten is tightened, never failed: only this check may lower it (via writesBaselines),
// so a shrink can't slip and can't become everyone else's merge conflict.
const tightened = [];
const next = { ...baseline };
for (const [path, allowed] of Object.entries(baseline)) {
    const now = perFile.get(path) ?? 0;
    if (now < allowed) {
        tightened.push(`${path}: ${allowed} → ${now}`);
        if (now === 0) {
            delete next[path];
        } else {
            next[path] = now;
        }
    }
}
if (tightened.length > 0) {
    if (writesBaselines()) {
        writeFileSync(BASELINE, `${JSON.stringify(Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b))), null, 4)}\n`);
        console.log(`path-literals: tightened _tools/checks/baselines/path-literals.json to what the tree has (${tightened.join(", ")}); it rides the next commit`);
    } else {
        console.log(
            `path-literals: the tree beats its baseline (${tightened.join(", ")}); the checkout that commits tightens _tools/checks/baselines/path-literals.json on its next run`,
        );
    }
}

if (grown.length > 0) {
    for (const line of grown) {
        console.error(line);
    }
    console.error(
        `\nA new hardcoded path. A location spelled in two files becomes two locations; a counted root breaks silently when its file moves. Use the constants; the baseline only covers what predates the rule.`,
    );
    process.exit(1);
}

console.log(
    `${tracked.length} tracked files, no new hand-spelled roots and no counted ones (${findings.length} standing in ${perFile.size} files, held by the baseline)`,
);
