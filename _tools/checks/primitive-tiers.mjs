#!/usr/bin/env node
// One door per concern (docs/architecture/conventions.md, "One door per concern"): the hand-rolled shapes that began
// most of the copies the shared mechanisms replaced, each named with the door to use instead. Read by shape, line by
// line, like the other tier checks; a comment is not a site. Standing sites are held per file in
// baselines/primitive-tiers.json, which may only shrink; a site that is right says why with
// `// allow(primitive-tiers): <reason>` (lib/allow.mjs).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedAt } from "./lib/allow.mjs";
import { ADOPTING, ratchet } from "./lib/ratchet.mjs";
import { finish } from "./lib/report.mjs";
import { root, subjectFiles } from "./lib/repo.mjs";

const CODE = /\.(ts|tsx|mts|js|mjs|vue)$/;
// A suite and its fixtures stand code up by hand on purpose, and a declaration file holds no code. The repository's own
// scripts, harnesses and test runners run under plain node before anything is built, so the shared doors in
// @intentic/base are not theirs to reach.
const EXEMPT = /(\.(test|spec|bench)\.[cm]?[jt]sx?$|(^|\/)testing\.ts$|\.testing\.ts$|\.d\.[cm]?ts$)/;
const TOOLING = /^(_tools\/(checks|scripts|testing|oxlint|e2e|perf|constants)\/|_site\/|_[a-z]+\/[^/]+\/scripts\/)/;

// Each copy: what it matches, where it applies, which file is the door itself, and the door to name in the finding.
const COPIES = [
    {
        id: `header-only body cap`,
        // A route reading the declared length to cap a body: a chunked request declares none.
        pattern: /\.header\(\s*["'`]content-length["'`]\s*\)/gi,
        within: (path) => path.startsWith(`_sandbox/sandbox/src/`),
        door: `readBoundedJson / readBoundedText / readBoundedBytes (_sandbox/sandbox/src/http/bounded-body.ts)`,
    },
    {
        id: `local hop-by-hop list`,
        // A list of headers to drop that spells the hop-by-hop ones itself.
        pattern: /["'`](?:proxy-authorization|transfer-encoding)["'`][^;]{0,400}?["'`]keep-alive["'`]|["'`]keep-alive["'`][^;]{0,400}?["'`](?:proxy-authorization|transfer-encoding)["'`]/gs,
        within: (path) => path !== `_sandbox/sandbox/src/http/forward-headers.ts`,
        door: `forwardHeaders (_sandbox/sandbox/src/http/forward-headers.ts)`,
    },
    {
        id: `".." prefix containment`,
        // `relative(...).startsWith("..")` reads an entry named `..stash` as a climb out of the root.
        pattern: /\.startsWith\(\s*(["'`])\.\.\1\s*\)/g,
        within: () => true,
        door: `isInside / insideRel (@intentic/base/contained), or a segment test`,
    },
    {
        id: `inline sleep`,
        // A timer promise that ignores abort and holds the process open.
        pattern: /new Promise(?:<[^>]*>)?\(\s*\(?\s*([\w$]+)\s*\)?\s*=>\s*\{?\s*(?:void\s+)?setTimeout\(\s*\1\b/g,
        within: () => true,
        door: `sleep (@intentic/base/async), which resolves on abort and can unref`,
    },
    {
        id: `card deadline`,
        // A card that refuses when a clock fires instead of waiting for its answer.
        pattern: /\bdeadlineMs\s*:/g,
        within: (path, text) => path.startsWith(`_sandbox/sandbox/src/`) && text.includes(`raiseRequest(`),
        door: `no deadline: a card waits (guard/card-offers.ts), and a call that cannot wait holds it with guard/held-asks.ts`,
    },
    {
        id: `raw browser storage`,
        // localStorage/sessionStorage throw where site data is off and over quota, and a key outside a declared scope
        // survives sign-out.
        pattern: /\b(?:localStorage|sessionStorage)\.(?:getItem|setItem|removeItem|clear|key)\s*\(/g,
        within: (path) => (path.startsWith(`_editor/`) || path.startsWith(`_extensions/`)) && path !== `_editor/ui/src/lib/browserStorage.ts`,
        door: `@intentic/ui/storage, with the key declared device, account or sandbox scope`,
    },
    {
        id: `promisified execFile`,
        // The daemon has process-tiers; everywhere else the same shape kills only the child and buffers without limit.
        pattern: /\bpromisify\(\s*execFile\s*\)/g,
        within: (path) => !path.startsWith(`_sandbox/sandbox/`),
        door: `runBounded / execBounded (@intentic/base/process)`,
    },
];

// Comments say what a shape is without being one: blank them, keeping offsets so line numbers still match.
const uncommented = (text) =>
    text.replace(/\/\*[\s\S]*?\*\/|(^|[^:\\])\/\/[^\n]*/g, (match, lead = ``) => lead + match.slice(lead.length).replace(/[^\n]/g, ` `));

const lineOf = (text, index) => text.slice(0, index).split(`\n`).length;

const files = subjectFiles(`_*`).filter((path) => CODE.test(path) && !EXEMPT.test(path) && !TOOLING.test(path));
const found = new Map();
const sites = new Map();
for (const path of files) {
    const text = readFileSync(join(root, path), `utf8`);
    const copies = COPIES.filter((copy) => copy.within(path, text));
    if (copies.length === 0) {
        continue;
    }
    const lines = text.split(`\n`);
    const code = uncommented(text);
    const here = [];
    for (const copy of copies) {
        for (const match of code.matchAll(copy.pattern)) {
            const line = lineOf(code, match.index);
            if (!allowedAt(lines, line, `primitive-tiers`)) {
                here.push({ line, copy });
            }
        }
    }
    if (here.length > 0) {
        found.set(path, here.length);
        sites.set(path, here);
    }
}

const { grown } = ratchet(`primitive-tiers`, `primitive-tiers`, found);
if (ADOPTING) {
    process.exit(0);
}
const problems = grown.flatMap(({ key, count, allowed }) => [
    ...sites.get(key).map(({ line, copy }) => `${key}:${line}  ${copy.id}: use ${copy.door}`),
    `${key}: ${count} hand-rolled site(s), the baseline allows ${allowed}`,
]);

finish(
    [[`a hand-rolled copy of a job that has one shared door (docs/architecture/conventions.md, "One door per concern"), or say why with // allow(primitive-tiers): <reason>`, problems]],
    [`${files.length} source files read: no new hand-rolled copy (${[...found.values()].reduce((sum, count) => sum + count, 0)} standing, held by the baseline)`],
);
