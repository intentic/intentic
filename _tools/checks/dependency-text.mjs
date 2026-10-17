#!/usr/bin/env node
// NO NEW BRANCH ON ANOTHER PROGRAM'S SENTENCE (docs/architecture/conventions.md, "Reading another program's output"). A
// failure's message and a child's stderr are worded by whoever produced them, and that wording moves: a runtime release
// (Node's fetch says `fetch failed`, Bun's says `Unable to connect`), a dependency bump (git 2.52's `replay` stopped
// printing what it moved), a translation (git under pl_PL). Code that branches on one keeps compiling, and its tests keep
// passing on their hand-written fixtures, while production takes the wrong branch. Read the structure instead: an errno,
// an exit status, an error's class or code (`@intentic/base/errors`), an HTTP status, a machine output format. Where only
// words exist, keep them in that dependency's one phrasebook and say at the site which dependency it is and what an
// unmatched wording falls back to: `// allow(dependency-text): <reason>` (lib/allow.mjs). Standing sites are held per
// file in baselines/dependency-text.json, which may only shrink.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";
import { textBranches } from "./lib/text-branches.mjs";

const CODE = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue)$/;
// A suite asserts on text on purpose, a declaration file holds no code, and the repository's own tooling reads its own
// tools' output under plain node before anything is built.
const EXEMPT = /(\.(test|spec|bench)\.[cm]?[jt]sx?$|(^|\/)testing\.ts$|\.testing\.ts$|\.d\.[cm]?ts$|(^|\/)(e2e|dist|node_modules|vendor|__fixtures__)\/)/;
const TOOLING = /^(_tools\/(checks|scripts|testing|oxlint|e2e|perf|constants)\/|_site\/|_[a-z]+\/[^/]+\/scripts\/)/;

const files = subjectFiles(`_*`).filter((path) => CODE.test(path) && !EXEMPT.test(path) && !TOOLING.test(path));
const found = new Map();
const sites = new Map();
for (const path of files) {
    const text = readFileSync(join(root, path), `utf8`);
    if (!text.includes(`message`) && !text.includes(`stderr`)) {
        continue;
    }
    const here = textBranches(text);
    if (here.length > 0) {
        found.set(path, here.length);
        sites.set(path, here);
    }
}

const { grown } = ratchet(`dependency-text`, `dependency-text`, found);
if (ADOPTING) {
    process.exit(0);
}
const problems = grown.flatMap(({ key, count, allowed }) => [
    ...sites.get(key).map(({ line, why }) => `${key}:${line}  ${why}`),
    `${key}: ${count} site(s) branching on another program's words, the baseline allows ${allowed}`,
]);
finish(
    [
        [
            `a branch on another program's wording: read its structure (errnoCode, exitCodeOf, networkCodeOf, isFetchNetworkFailure from @intentic/base/errors, an SDK error's code, an HTTP status, a machine format), or keep the words in its phrasebook and say which dependency and what an unmatched wording falls back to with // allow(dependency-text): <reason>`,
            problems,
        ],
    ],
    [`${files.length} source files read: no new branch on another program's wording (${[...found.values()].reduce((sum, count) => sum + count, 0)} standing, held by the baseline)`],
);
