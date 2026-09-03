#!/usr/bin/env node
/* THE RELEASE-BODY HEADINGS ARE ONE CONTRACT SPELLED IN THREE FILES that share no dependency edge:
 * publish-github.sh writes "## Breaking changes" and "## What's new" into the Release, and the daemon's update
 * card (release-notes.ts) and the site's changelog page (changelog.ts) parse them back off it. Each parser is
 * deliberately its own copy: the files say why, so nothing but this check notices a drifted spelling. And a
 * drift fails NOTHING at runtime: the section simply stops being seen, which for the breaking heading means a
 * breaking update is offered as routine, the one silence the heading exists to prevent. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";

const HEADINGS = ["What's new", "Breaking changes"];
const HEADING_FILES = ["_tools/scripts/publish-github.sh", "_sandbox/sandbox/src/platform/release-notes.ts", "_site/site/src/lib/changelog.ts"];

const headingDrift = [];
for (const file of HEADING_FILES) {
    const text = readFileSync(join(root, file), "utf8");
    for (const heading of HEADINGS.filter((spelling) => !text.includes(spelling))) {
        headingDrift.push(`${file}: no longer spells "${heading}", writer and both parsers must stay in step`);
    }
}

finish([["The release-body headings drifted apart (they are parsed, not prose)", headingDrift]], [
    "release headings: writer and both parsers spell the same two sections",
]);
