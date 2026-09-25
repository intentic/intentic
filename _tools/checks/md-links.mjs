#!/usr/bin/env node
// Checks that every relative link in tracked Markdown resolves on disk. Skips fenced code and inline code spans, links
// with a scheme or `#` anchor, `<placeholder>`/`${...}` templated paths, and the seeds copied into other projects
// (scaffold, extension-example, registry-scan). Also that a `docs/….md` path a code or config COMMENT names resolves,
// from the repository root or from the file: a comment citing a deleted page sends its reader nowhere, and five
// workflows and three migrations did exactly that after the design docs and audits were dropped.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { allowedAt } from "./lib/allow.mjs";
import { finish } from "./lib/report.mjs";
import { root, trackedFiles } from "./lib/repo.mjs";

// Copied out of this repo and read elsewhere; their relative links aren't about this tree.
const COPIED_OUT = ["_tools/extension-example/seed/", "_tools/registry-scan/seed/", "_sandbox/scaffold/templates/", "_sandbox/scaffold/seed/"];

const INLINE_LINK = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const REFERENCE_LINK = /^\s{0,3}\[[^\]]+\]:\s+(\S+)/;
const SCHEME = /^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i;
const TEMPLATED = /[<>${}*]|^%/;

const targetsIn = (text) => {
    const found = [];
    let fenced = false;
    for (const [at, line] of text.split("\n").entries()) {
        if (/^\s*(```|~~~)/.test(line)) {
            fenced = !fenced;
            continue;
        }
        if (fenced) {
            continue;
        }
        // Inline code shows markdown syntax as an example, not a real link.
        const prose = line.replaceAll(/`[^`]*`/g, "");
        const reference = REFERENCE_LINK.exec(prose);
        for (const target of [...(reference ? [reference[1]] : []), ...[...prose.matchAll(INLINE_LINK)].map((match) => match[1])]) {
            found.push({ target, line: at + 1 });
        }
    }
    return found;
};

const findings = [];
// Every page something links to, so an unlinked page can be told from a merely quiet one.
const linked = new Set();
const markdown = trackedFiles().filter((path) => path.endsWith(".md") && !COPIED_OUT.some((prefix) => path.startsWith(prefix)));
let checked = 0;
for (const path of markdown) {
    let text;
    try {
        text = readFileSync(join(root, path), "utf8");
    } catch {
        continue; // a symlink to nowhere, or a path removed since `ls-files` answered
    }
    for (const { target, line } of targetsIn(text)) {
        // An in-page anchor, an absolute URL, or a templated path: none of them is a file here.
        const [pathPart] = target.split("#");
        if (SCHEME.test(target) || TEMPLATED.test(pathPart) || pathPart === "") {
            continue;
        }
        checked++;
        // A leading slash means the repo root; anything else resolves relative to the file with the link.
        const resolved = pathPart.startsWith("/") ? join(root, pathPart) : normalize(join(root, dirname(path), decodeURIComponent(pathPart)));
        if (existsSync(resolved)) {
            linked.add(relative(root, resolved));
            continue;
        }
        findings.push(`${path}:${line}  → ${pathPart}`);
    }
}

// A comment naming a docs page, in the files that carry comments. Suites are skipped (their comments describe the temp
// trees they build), and so are applied migrations, which check-migrations.sh keeps byte-identical forever, so a
// citation in one cannot be corrected. An example path is marked `// allow(md-links): <why>` in its comment.
const COMMENTED = /\.(ts|tsx|mts|cts|js|mjs|cjs|vue|astro|ya?ml|sql|sh|toml|rs|py|css)$|(^|\/)Dockerfile[^/]*$/;
const NOT_COMMENTS = [/\.(test|spec)\.[cm]?[jt]sx?$/, /^_platform\/prisma\/migrations\//, /^_tools\/nav\/baselines\//];
const COMMENT = /(?:^|\s)(?:\/\/|#|\*|\/\*|--|<!--)(.*)$/;
const DOC_MENTION = /(?<![\w/.@-])((?:\.\.?\/)*(?:[\w.-]+\/)*docs\/[\w./-]*?\.md)\b/g;
const commented = trackedFiles().filter((path) => COMMENTED.test(path) && !NOT_COMMENTS.some((pattern) => pattern.test(path)) && !COPIED_OUT.some((prefix) => path.startsWith(prefix)));
const mentions = [];
let cited = 0;
for (const path of commented) {
    let text;
    try {
        text = readFileSync(join(root, path), "utf8");
    } catch {
        continue; // a symlink to nowhere, or a path removed since `ls-files` answered
    }
    if (!text.includes("docs/")) {
        continue;
    }
    const lines = text.split("\n");
    for (const [at, line] of lines.entries()) {
        const comment = COMMENT.exec(line)?.[1];
        if (comment === undefined || allowedAt(lines, at + 1, "md-links")) {
            continue;
        }
        for (const [, target] of comment.matchAll(DOC_MENTION)) {
            cited++;
            if (!existsSync(join(root, target)) && !existsSync(normalize(join(root, dirname(path), target)))) {
                mentions.push(`${path}:${at + 1}  → ${target}`);
            }
        }
    }
}

// Closes the other direction: every page under docs/architecture/ must be named by the index, not just every link in it
// resolving. repo.json's generated index.json is exempt.
const architecture = trackedFiles().filter((path) => /^docs\/architecture\/[^/]+\.md$/.test(path));
const orphans = architecture.filter((page) => !linked.has(page));

finish(
    [
        [
            "these documentation links point at a path that does not exist, which is how a rename turns a README into a wrong map\n" +
                "  fix the target, or delete the link if what it named is gone",
            findings,
        ],
        [
            "these comments cite a docs page that does not exist: point at what documents it now, or say the reason in the\n" +
                "  comment itself if the page is gone (mark an example path // allow(md-links): <why>)",
            mentions,
        ],
        [
            "these architecture pages are named by nothing: add them to the index in ARCHITECTURE.md, or a reader\n" +
                "  arriving from it never learns they exist (and the next person to tidy the directory deletes them)",
            orphans,
        ],
    ],
    [
        `${markdown.length} tracked markdown files, ${checked} relative links: every one resolves`,
        `${commented.length} commented files, ${cited} docs pages cited in comments: every one resolves`,
        `${architecture.length} architecture pages: every one is reachable from the index`,
    ],
);
