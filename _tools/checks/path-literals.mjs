#!/usr/bin/env node
/* NO HAND-SPELLED ROOTS, AND NO COUNTING THE WAY UP TO ONE: the two habits that made every path in this repo
 * quietly position-dependent.
 *
 * COUNTING. Two dozen files worked out where the monorepo root was by counting how deep they sat: `../..` from
 * a package directory, `../../..` from its src, `../../../..` from the installer scripts. Each number is right
 * for exactly one location and is checked by nothing, so moving a file resolves it somewhere else in silence:
 * no import fails, no type breaks, and you find out when a config loader reads no .env and hands back empty
 * credentials. `repoRoot()` / `packageRoot()` from @intentic/constants/node walk up to a marker instead, which
 * has no such coupling. In shell, `_tools/scripts/repo-root.sh` does the same.
 *
 * SPELLING. `/work`, `/history`, `.intentic` and `/opt/intentic` were typed out by hand in hundreds of places
 * with nothing linking the copies, so a rename fixed some and orphaned the rest. @intentic/constants names each
 * one once.
 *
 * WHAT THIS DELIBERATELY ALLOWS, because each is a real distinction rather than an oversight:
 *
 *   - ASSERTION LINES IN TESTS. A test that checks a returned path against the same constant the code under
 *     test used agrees with the implementation by construction and can no longer catch a wrong root. Fixtures
 *     (the paths a test feeds IN) must use the constants; expectations stay spelled out. That split is the
 *     whole reason this check parses tests instead of skipping them.
 *   - `join(x, "..")` WHERE x IS COMPUTED. "The parent of this directory" is an operation, not a location.
 *     Only `..` counted from `import.meta.dirname` / `import.meta.url` / `$0` is a position claim.
 *   - THE FILES THAT CANNOT IMPORT. The installer scripts are downloaded and run standalone; intentic-docs
 *     ships as a raw directory on the agent's PATH with no node_modules. They keep literal copies, by name,
 *     and the constants README records the obligation that goes with that.
 *   - `homedir()`-BASED `.intentic`. The user's home config directory shares a name with the workspace state
 *     directory and is a different place; coupling them would make renaming one rename the other. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repoRoot } from "../constants/src/node.mjs";

const root = repoRoot(import.meta.url);

/* THE BASELINE, and why this check has one when the others refuse. The rule was written after the sweep that
 * introduced the constants, and the sweep did not finish: 269 spellings across the tree were still there the
 * day this check was first RUN by anything (it lived in `pnpm check`, which no hook and no job ran). Fixing them
 * all at once is a repository-wide edit with its own risk; refusing every push until someone does is how a
 * check gets switched off. So the standing findings are written down here, per file, as a number that may
 * shrink and may not grow: a file with MORE spellings than its entry fails, a file that no longer has as many
 * as its entry fails too (update the entry, or delete it once the file is clean), and a file not listed fails
 * on its first. Shrink this file; never grow it. `--write-baseline` rewrites it from the current findings for
 * the one occasion that is legitimate, adopting the rule. */
const BASELINE = join(root, "_tools/checks/baselines/path-literals.json");
const writeBaseline = process.argv.includes("--write-baseline");

/* The files that are allowed to spell a root literally, each for a reason that is about reach, not taste:
 * two of them define the constants, and the rest cannot resolve a bare import at the moment they run. */
const MAY_SPELL_A_ROOT = new Set([
    `_tools/constants/src/index.ts`, // where the names are defined
    `_tools/constants/src/node.mjs`, // the walker itself
    `_tools/checks/path-literals.mjs`, // this file: the patterns below are the check
    `_tools/scripts/repo-root.sh`, // the shell walker
    `_site/site/public/scripts/connect.sh`, // downloaded and run standalone
    `_site/site/public/scripts/recreate.sh`, // downloaded and run standalone
    `_extensions/documentation/bin/intentic-docs`, // ships as a raw dir on the agent's PATH, no node_modules
    // The scaffolded extension template. It is copied OUT of this repo into a user's own project and must stay
    // installable from npm with the one dependency it declares, so it cannot reach an intentic internal for a
    // string: the same bargain the file's own header already makes about @intentic/sandbox-contract.
    `_tools/extension-example/seed/src/notes.ts`,
]);

/* Committed BUILD OUTPUT. The site ships a bundled copy of the demo, so these are minified artifacts of source
 * that is itself checked here: flagging them would be flagging the same line twice, once where it can be
 * fixed and once where it cannot. */
const GENERATED = [`_apps/site/public/`, `_apps/site/dist/`, `_editor/web/public/ext-shims/`, `_sandbox/sandbox/operator-templates/`];

// A filesystem root spelled out. `/workspace` and `/workflows` are HTTP ROUTES that merely start with the same
// letters, so the boundary after the root is required rather than assumed.
const SPELLED_ROOT = /(["'`])(\/work|\/history|\/opt\/intentic)(\/[^"'`${\n]*)?\1/;

/* `/history/...` IS ALSO AN HTTP ROUTE PREFIX: the snapshot surface answers on /history/snapshots, /history/diff
 * and friends. Those are a different namespace that happens to share a spelling: they are wire paths the browser
 * and the daemon agree on, not directories, and pointing them at HISTORY_ROOT would mean a rename of the history
 * VOLUME silently moved the API. Recognised by the company they keep, since the strings themselves are
 * identical in shape to a filesystem path. */
const ROUTE_CONTEXT = /oc\.route\(|\bpath:\s*["'`]\/|sandboxJson|sandboxRequest|app\.(get|post|put|patch|delete)\(|\bfetch\(|\.request\(/;
// The workspace state dir, except where the line is plainly about the user's HOME.
const SPELLED_STATE = /(["'`])\.intentic(\/[^"'`${\n]*)?\1/;

/* WHERE A SPELLED-OUT `.intentic/…` IS THE STRONGER MECHANISM, NOT A WEAKER ONE.
 *
 * `statePath(root, path)` takes `WorkspaceStatePath`: the literal-union type produced by the `as const` state
 * table in the contract. A caller can therefore only name a file the table declares, and renaming an entry
 * breaks the build until both move together. Swapping in `${STATE_DIR}/…` would turn each of those checked
 * literals into an ordinary string and throw that guarantee away, which is the opposite of what this check is
 * for: STATE_DIR exists for callers OUTSIDE the table, and the table's own members stay literal so the compiler
 * keeps its hold on them. The table's declaring files are exempt for the same reason: they ARE the union. */
const TYPED_STATE_PATH = /state(?:Rel)?Path\(/;
const STATE_TABLE_FILES = new Set([`_sandbox/sandbox-contract/src/workspace-state.ts`, `_sandbox/sandbox-contract/src/history-state.ts`]);
// Counting up to a root from the running file's own location: the position claim, in each spelling that
// reaches PAST the file's own directory (a single `..` inside a package is a sibling, not a root claim).
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

// Is this line an assertion, or a continuation of one that has not been terminated yet? Same rule the
// conversion used, so what the check permits and what the codebase does are one decision.
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

/* THE ONE ESCAPE HATCH, for the case the rules above genuinely cannot see: a string that LOOKS like a path but
 * IS the text under test: shell source a rewriter must leave byte-for-byte alone, a simulated stderr line, a
 * fixture transcript. Substituting a constant there does not move a location, it edits the subject of the test.
 *
 * Deliberately per-line and deliberately requiring a reason, rather than a per-file exemption: a whole file
 * waved through stops being checked the day someone adds a real path to it. Write it as
 *   // path-literals: content, <why this is text, not a location>
 * on the offending line or the one above it. */
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
                        ? `counts its way to the repo root: source _tools/scripts/repo-root.sh and call repo_root`
                        : `counts its way to a root, use repoRoot()/packageRoot() from @intentic/constants/node`,
                });
                break;
            }
        }
        if (shell) {
            continue; // a shell script has no import to reach the named constants through
        }
        // In a test, an expectation is allowed to spell a root: that literal is what makes the assertion able
        // to fail. Everything else in a test is a fixture and goes through the constants like any other code.
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

// Findings per file, which is the unit the baseline counts in: a line number moves with every edit above it.
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
const stale = Object.entries(baseline)
    .filter(([path, allowed]) => (perFile.get(path) ?? 0) < allowed)
    .map(([path, allowed]) => `${path}: the baseline allows ${allowed}, the file now has ${perFile.get(path) ?? 0}: lower or remove its entry in _tools/checks/baselines/path-literals.json in the same change`);

if (grown.length > 0 || stale.length > 0) {
    for (const line of grown) {
        console.error(line);
    }
    if (grown.length > 0) {
        console.error(
            `\nA new hardcoded path. A location spelled in two files becomes two locations; a counted root breaks silently when its file moves. Use the constants; the baseline only covers what predates the rule.`,
        );
    }
    for (const line of stale) {
        console.error(line);
    }
    process.exit(1);
}

console.log(
    `${tracked.length} tracked files, no new hand-spelled roots and no counted ones (${findings.length} standing in ${perFile.size} files, held by the baseline)`,
);
