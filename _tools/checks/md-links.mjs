#!/usr/bin/env node
/* EVERY RELATIVE LINK IN THE DOCUMENTATION POINTS AT SOMETHING THAT EXISTS.
 *
 *   node _tools/checks/md-links.mjs
 *
 * The READMEs are the map: 401 of the sessions mined for the directory overhaul read one, more than read
 * ARCHITECTURE.md and the wire schemas put together. A `## Key files` list whose links rotted after a rename
 * is worse than no list — it sends an agent to a path that does not exist, and a failed Read is the most
 * expensive tool call there is, because the agent then GUESSES.
 *
 * Prose, not code, which is why this is its own check rather than a rule inside layout.mjs: it reads Markdown,
 * it resolves against the filesystem, and it has to know that a link into a directory is legitimate while a
 * link to a file that moved is not.
 *
 * WHAT IT SKIPS, and why each is not a link:
 *   - fenced code blocks and inline code spans: a sample that SHOWS markdown (`[label](url)` in the messaging
 *     skills, telling an agent which syntax renders literally there), or a shell transcript.
 *   - anything with a scheme (http:, mailto:, tel:) or starting with `#`: not a path in this tree.
 *   - `<placeholder>` and `${...}` segments: a template of a path, not a path.
 *   - the seeds: scaffold, the extension example and registry-scan's, whose links resolve inside the project
 *     they are copied INTO. */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import { finish } from "./lib/report.mjs";
import { root, trackedFiles } from "./lib/repo.mjs";

// Copied out of this repo and read somewhere else, so their relative links are not about this tree.
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
        // Inline code is what a doc says ABOUT markdown, not markdown: `[label](url)` is the example, not a link.
        const prose = line.replaceAll(/`[^`]*`/g, "");
        const reference = REFERENCE_LINK.exec(prose);
        for (const target of [...(reference ? [reference[1]] : []), ...[...prose.matchAll(INLINE_LINK)].map((match) => match[1])]) {
            found.push({ target, line: at + 1 });
        }
    }
    return found;
};

const findings = [];
// Every page something links to, so a page nothing links to can be told from one that is merely quiet.
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
        // An in-page anchor, an absolute URL, or a path spelled as a template: none of them is a file here.
        const [pathPart] = target.split("#");
        if (SCHEME.test(target) || TEMPLATED.test(pathPart) || pathPart === "") {
            continue;
        }
        checked++;
        // A leading slash in these docs means the repo root (that is how the site and the editor render them),
        // and anything else is relative to the file that carries the link.
        const resolved = pathPart.startsWith("/") ? join(root, pathPart) : normalize(join(root, dirname(path), decodeURIComponent(pathPart)));
        if (existsSync(resolved)) {
            linked.add(relative(root, resolved));
            continue;
        }
        findings.push(`${path}:${line}  → ${pathPart}`);
    }
}

/* THE ARCHITECTURE PAGES ARE REACHABLE FROM THE INDEX, both ways.
 *
 * `ARCHITECTURE.md` used to be 1,226 lines and is now a 39-line index over `docs/architecture/*.md`. That is a
 * better document and a new failure mode: prose that was one file nobody could delete by accident is now ten
 * files somebody can. The rule closes both directions — a page the index names must exist (the link check
 * above), and a page nothing names must not (here) — so losing one of them is a red check rather than a
 * paragraph that quietly stops existing. `repo.json`'s generated `index.json` is not prose and is exempt. */
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
            "these architecture pages are named by nothing: add them to the index in ARCHITECTURE.md, or a reader\n" +
                "  arriving from it never learns they exist (and the next person to tidy the directory deletes them)",
            orphans,
        ],
    ],
    [
        `${markdown.length} tracked markdown files, ${checked} relative links: every one resolves`,
        `${architecture.length} architecture pages: every one is reachable from the index`,
    ],
);
