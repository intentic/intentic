#!/usr/bin/env node
// Everything a person sees in a terminal from intentic draws through one of two renderers: _sandbox/ic/src/ui.rs for
// `ic`, _devices/local-agent/src/ui.ts for `intentic-machine` (both held to one layout fixture). A `println!` or a
// `process.stdout.write` beside them is a line in its own voice, which is how fifteen commands came to look like
// fifteen unrelated scripts. The rules are docs/ops/cli-output-protocol.md. Machine output (a --json document, a marker
// line a parser reads) is a right reason to write directly: say so with `// allow(terminal-output): <reason>`.
//
// Ratcheted per file: the standing count may shrink and never grow unasked. A deliberate one records itself with
// `node _tools/checks/terminal-output.mjs --allow <file> --reason "<why>"`, which works from a worktree.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedAt } from "./lib/allow.mjs";
import { ADOPTING, allowOne, ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

const CHECK = `terminal-output`;

// Which files speak to a person, how each prints directly, and what in it is not printing to a person.
const SOURCES = [
    {
        about: `ic`,
        matches: (path) => path.startsWith(`_sandbox/ic/src/`) && path.endsWith(`.rs`),
        // The renderer itself, and main.rs, which only defines the crate's println!/eprintln! (rerouted under --json).
        exempt: (path) => path === `_sandbox/ic/src/ui.rs` || path === `_sandbox/ic/src/main.rs` || /(^|\/)tests?(\.rs|\/)/.test(path),
        print: /\b(?:e?println!|e?print!)\s*\(/g,
        // ic keeps its unit tests in a trailing `#[cfg(test)] mod tests { … }`, which may print what it likes. Only an
        // inline module ends the body: a `#[cfg(test)] mod helpers;` declaration near the top is not the tests.
        body: (text) => {
            const at = text.search(/^#\[cfg\(test\)\]\s*\n\s*mod\s+\w+\s*\{/m);
            return at === -1 ? text : text.slice(0, at);
        },
    },
    {
        about: `intentic-machine`,
        matches: (path) => path.startsWith(`_devices/machine/src/`) && /\.[cm]?ts$/.test(path),
        exempt: (path) => /\.(test|spec|bench)\.[cm]?ts$/.test(path) || /(^|\/)(tests?|fixtures?)\//.test(path) || path.endsWith(`.d.ts`),
        print: /\b(?:console\.(?:log|error|warn|info)|(?:this\.)?process\.(?:stdout|stderr)\.write)\s*\(/g,
        body: (text) => text,
    },
];

const lineOf = (text, index) => text.slice(0, index).split(`\n`).length;

const allowArg = process.argv.includes(`--allow`) ? (process.argv[process.argv.indexOf(`--allow`) + 1] ?? ``) : undefined;

const files = subjectFiles().flatMap((path) => {
    const source = SOURCES.find((candidate) => candidate.matches(path));
    return source === undefined || source.exempt(path) ? [] : [{ path, source }];
});

const found = new Map();
const sites = new Map();
for (const { path, source } of files) {
    const text = readFileSync(join(root, path), `utf8`);
    const body = source.body(text);
    const lines = text.split(`\n`);
    const here = [];
    for (const match of body.matchAll(source.print)) {
        const line = lineOf(body, match.index);
        if (!allowedAt(lines, line, CHECK)) {
            here.push(line);
        }
    }
    if (here.length > 0) {
        found.set(path, here.length);
        sites.set(path, here);
    }
}

if (allowArg !== undefined) {
    if (allowArg === `` || allowArg.startsWith(`--`)) {
        console.error(`${CHECK}: --allow needs the file to record, e.g. --allow ${[...found.keys()][0] ?? `_sandbox/ic/src/<file>.rs`}`);
        process.exit(2);
    }
    allowOne(CHECK, CHECK, allowArg, found.get(allowArg) ?? 0);
    console.log(`${CHECK}: recorded ${allowArg} at ${found.get(allowArg) ?? 0}`);
    process.exit(0);
}

const { grown } = ratchet(CHECK, CHECK, found);
if (ADOPTING) {
    process.exit(0);
}

const problems = grown.flatMap(({ key, count, allowed }) => [
    ...sites.get(key).map((line) => `${key}:${line}  prints directly instead of through the renderer`),
    `${key}: ${count} direct print(s), the baseline allows ${allowed}`,
]);
const standing = [...found.values()].reduce((sum, count) => sum + count, 0);

finish(
    [
        [
            `a new line printed beside the renderer: draw it through ui.rs / ui.ts (docs/ops/cli-output-protocol.md), or, for machine output, say why with // allow(${CHECK}): <reason>`,
            problems,
        ],
    ],
    [`${files.length} files of ic and intentic-machine read: no new direct print (${standing} standing, held by the baseline)`],
);
