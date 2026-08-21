#!/usr/bin/env node
/* ONE-SHOT: rewrite every `.intentic/<name>` spelling to its group folder.
 *
 * The state dir grew flat: forty-nine entries, config beside caches beside credentials, so every rule over it
 * (the git exclude, the search allow-list, the sync backup, the watcher skip, the export bundle) carried its own
 * list of paths. The entries already answered the questions those rules ask, and the answers nest, so the layout
 * can carry them instead: five folders, one prefix each.
 *
 * The MAPPING IS READ FROM THE TABLE rather than written here, so this script cannot disagree with the code it is
 * rewriting toward: it parses the (already-moved) entries out of workspace-state.ts and derives each old
 * spelling from its new one. Run it against the rest of the repo after the table itself has moved.
 *
 * Matching is a single global pass over a longest-tail-first alternation, which is what keeps the pairs that
 * share a prefix apart: `verify.json` is a record and `verify/` is rebuildable, `environment.Dockerfile` is
 * config and `environment.approved.Dockerfile` is not. One pass also means nothing can be rewritten twice.
 *
 * Delete this file once the rename has landed. It documents a move, not a rule.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { repoRoot } from "@intentic/constants/node";

const root = repoRoot(import.meta.url);
const TABLE = `${root}/_sandbox/sandbox-contract/src/workspace-state.ts`;

// Every entry as the table NOW declares it: `.intentic/<group>/<tail>`. The old spelling is the same minus group.
const table = readFileSync(TABLE, "utf8");
const declared = [...table.matchAll(/path:\s*"\.intentic\/([a-z]+)\/([^"]+)"/g)].map(([, group, tail]) => ({ group, tail }));
if (declared.length !== 49) {
    throw new Error(`expected 49 moved entries in the table, found ${declared.length}: has it been moved yet?`);
}

// Longest tail first: a shorter tail that prefixes a longer one would otherwise claim it.
const ordered = declared.toSorted((a, b) => b.tail.length - a.tail.length);
const groupFor = new Map(ordered.map(({ group, tail }) => [tail, group]));
const escape = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const TAILS = ordered.map(({ tail }) => escape(tail)).join("|");

/* A DIRECTORY ENTRY IS DECLARED WITH ITS TRAILING SLASH (`browser/`), so the patterns above only find it where a
 * path continues into it: `.intentic/browser/reddit/Cookies`. The bare form is just as common and means the
 * same thing: `.intentic/browser` as a tree to assert on, to mkdir, or to name in a sentence. Missing it is what
 * left a test creating `.intentic/cache` and then asserting about `.intentic/local/cache/iq` inside it.
 *
 * The boundary is what keeps `browser` off `browser-profiles` and `tmp` off `tmpdir`: the name must not run on
 * into another path character. */
const bareDirs = ordered.filter(({ tail }) => tail.endsWith("/")).map(({ group, tail }) => ({ group, name: tail.replace(/\/$/, "") }));
const BARE = bareDirs.map(({ name }) => escape(name)).join("|");
const bareGroupFor = new Map(bareDirs.map(({ group, name }) => [name, group]));

/* THE SEGMENT-LIST SPELLING: `join(root, ".intentic", "personas", id)`, which is neither a path literal nor a
 * template and so slipped past all four patterns above. It is the form the daemon's own helpers and their tests
 * reach for whenever a caller supplies the last segment.
 *
 * Keyed on the FIRST segment only, since that is all the join exposes. Ambiguity would be silent and wrong, so
 * it is checked rather than assumed: `verify.json` is a record and `verify/` is rebuildable, and if two entries
 * ever shared a first segment across two groups this could not know which one a join meant.
 *
 * The homedir case needs no special handling and is worth saying so out loud: `join(homedir(), ".intentic",
 * "logs")` is the USER's config dir, a different place that happens to share a name (path-literals.mjs makes the
 * same point). It survives because `logs` is not a declared entry: the tail check is the guard. */
const firstSegments = new Map();
for (const { group, tail } of ordered) {
    const head = tail.replace(/\/$/, "").split("/")[0];
    const seen = firstSegments.get(head);
    if (seen !== undefined && seen !== group) {
        throw new Error(`"${head}" is the first segment of entries in both ${seen} and ${group}: a join cannot be rewritten unambiguously`);
    }
    firstSegments.set(head, group);
}
const HEADS = [...firstSegments.keys()]
    .toSorted((a, b) => b.length - a.length)
    .map((head) => escape(head))
    .join("|");

/* FOUR SPELLINGS, because the repo deliberately has four, and each had to be found the hard way.
 *   - `.intentic/x`: an ASSERTION. path-literals.mjs requires expectations to be spelled out, precisely so they
 *     cannot agree with the code by construction.
 *   - `${STATE_DIR}/x`: a FIXTURE. The same check requires inputs to come from the constant.
 *   - `join(root, STATE_DIR, "x")`: the fixture rule again, as a segment list.
 *   - `join(root, ".intentic", "x", id)`: a segment list where the last part is supplied by the caller.
 * Each also has a bare-directory form, since a directory entry is declared with its trailing slash and so is
 * only matched where a path continues into it.
 *
 * `put` receives the pattern's capture groups in declaration order. */
const PATTERNS = [
    // Both separators on the literal form: the daemon holds these as platform paths in places, and the tests
    // pin the Windows spelling.
    { re: new RegExp(String.raw`\.intentic([/\\])(${TAILS})`, "g"), put: (sep, tail) => `.intentic${sep}${groupFor.get(tail)}${sep}${tail}` },
    { re: new RegExp(String.raw`\$\{STATE_DIR\}/(${TAILS})`, "g"), put: (tail) => `\${STATE_DIR}/${groupFor.get(tail)}/${tail}` },
    { re: new RegExp(String.raw`STATE_DIR, "(${TAILS})"`, "g"), put: (tail) => `STATE_DIR, "${groupFor.get(tail)}", "${tail}"` },
    // Bare directory names, both spellings, with a boundary so a longer name that merely starts the same is safe.
    {
        re: new RegExp(String.raw`\.intentic([/\\])(${BARE})(?![A-Za-z0-9._/\\-])`, "g"),
        put: (sep, name) => `.intentic${sep}${bareGroupFor.get(name)}${sep}${name}`,
    },
    {
        re: new RegExp(String.raw`\$\{STATE_DIR\}/(${BARE})(?![A-Za-z0-9._/-])`, "g"),
        put: (name) => `\${STATE_DIR}/${bareGroupFor.get(name)}/${name}`,
    },
    // `join(root, ".intentic", "personas", …)` and its backtick twin, plus the STATE_DIR-constant form.
    {
        re: new RegExp(String.raw`(["\`])\.intentic\1(,\s*)(["\`])(${HEADS})\3`, "g"),
        put: (q1, comma, q2, head) => `${q1}.intentic${q1}${comma}${q2}${firstSegments.get(head)}${q2}${comma}${q2}${head}${q2}`,
    },
    {
        re: new RegExp(String.raw`\bSTATE_DIR(,\s*)(["\`])(${HEADS})\2`, "g"),
        put: (comma, quote, head) => `STATE_DIR${comma}${quote}${firstSegments.get(head)}${quote}${comma}${quote}${head}${quote}`,
    },
    /* And the same thing wearing a template: `join(root, `${STATE_DIR}`, "browser", "Default")`. The interpolation
     * is a whole string argument, so the pattern above cannot see past its closing brace and backtick, which is
     * how two watcher fixtures went on creating flat directories while asserting about grouped ones. */
    {
        re: new RegExp(String.raw`\$\{STATE_DIR\}\`(,\s*)(["\`])(${HEADS})\2`, "g"),
        put: (comma, quote, head) => `\${STATE_DIR}\`${comma}${quote}${firstSegments.get(head)}${quote}${comma}${quote}${head}${quote}`,
    },
];

/* Each pass is idempotent by construction: a rewritten path reads `.intentic/<group>/<tail>`, and `<group>` is
 * never itself a tail, so the second run finds nothing to match. That matters: this is run over an overlapping
 * file list more than once while the fallout is chased down.
 *
 * `put` is handed the capture groups only (the trailing offset and full-string arguments `replaceAll` appends
 * are dropped), in the order the pattern declares them. */
const rewrite = (text) =>
    PATTERNS.reduce(
        (acc, { re, put }) =>
            acc.replaceAll(re, (...args) => {
                const captures = args.slice(1, -2);
                return put(...captures);
            }),
        text,
    );

/* THE ONE FILE THAT MEANS THE OLD SPELLINGS ON PURPOSE.
 *
 * The janitor's test is about the QUARANTINE record: abandoned roots left at the flat spelling by a sandbox
 * that predates the grouping, which the boot sweep deletes. Every `.intentic/browser` in it is deliberately the
 * old path, and rewriting them turns the test into one that asserts the live profiles get deleted. Nothing in a
 * path can distinguish the two readings, so the file is named here instead. */
const MEANS_THE_OLD_SPELLING = ["_sandbox/sandbox/src/workspace/state-janitor.integration.test.ts"];

const files = process.argv.slice(2).filter((file) => !MEANS_THE_OLD_SPELLING.some((skip) => file.endsWith(skip)));
if (files.length === 0) {
    throw new Error("usage: regroup-state.mjs <file>…");
}
let touched = 0;
for (const file of files) {
    const before = readFileSync(file, "utf8");
    const after = rewrite(before);
    if (after !== before) {
        writeFileSync(file, after);
        touched++;
    }
}
console.log(`rewrote ${touched} of ${files.length} file(s)`);
