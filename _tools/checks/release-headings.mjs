#!/usr/bin/env node
/* THE RELEASE-BODY HEADINGS ARE ONE CONTRACT SPELLED IN FOUR FILES that share no dependency edge:
 * publish-github.sh writes "## Breaking changes" and "## What's new" into the Release, and the daemon's update
 * card (release-notes.ts), the site's changelog page (changelog.ts) and the community announcement
 * (post-release-discord.mjs) parse them back off it. Each parser is deliberately its own copy: the files say
 * why, so nothing but this check notices a drifted spelling. And a drift fails NOTHING at runtime: the section
 * simply stops being seen, which for the breaking heading means a breaking update is offered as routine, the
 * one silence the heading exists to prevent. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";

const HEADINGS = ["What's new", "Breaking changes"];
const HEADING_FILES = [
    "_tools/scripts/release/publish-github.sh",
    "_sandbox/sandbox/src/platform/release-notes.ts",
    "_site/site/src/lib/changelog.ts",
    "_tools/scripts/release/post-release-discord.mjs",
];

const headingDrift = [];
for (const file of HEADING_FILES) {
    const text = readFileSync(join(root, file), "utf8");
    for (const heading of HEADINGS.filter((spelling) => !text.includes(spelling))) {
        headingDrift.push(`${file}: no longer spells "${heading}", writer and both parsers must stay in step`);
    }
}

/* AND THE RANGE THOSE SECTIONS ARE BUILT FROM IS NOT EMPTY.
 *
 * publish-github.sh runs as semantic-release's publishCmd, which means THIS release's tag is already on HEAD
 * by the time it asks git what the previous release was. An unfiltered `git describe --tags --abbrev=0`
 * answers with the tag it is standing on, the range collapses to `vX.Y.Z..HEAD` — nothing — and the Release
 * publishes with empty notes. `--exclude "$TAG"` is the whole of what prevents that, and the file says so.
 *
 * It had no coverage, which is how a one-flag deletion could have shipped a notes-less release with every gate
 * green. So this DEMONSTRATES the failure rather than grepping for the flag: a throwaway repository with two
 * release tags, described both ways. If `--exclude` ever stops meaning what this depends on — or stops being
 * in the command — one of the two assertions below fails by name. */
const rangeProblems = [];
const publisher = readFileSync(join(root, "_tools/scripts/release/publish-github.sh"), "utf8");
const describeLine = publisher.split("\n").find((line) => line.trimStart().startsWith("prev=") && line.includes("git describe"));
if (describeLine === undefined) {
    rangeProblems.push("publish-github.sh no longer resolves the previous release with `git describe` into `prev`, so this check cannot see the range it builds");
} else if (!describeLine.includes('--exclude "$TAG"')) {
    rangeProblems.push(
        'publish-github.sh describes the previous release without `--exclude "$TAG"`. It runs in publishCmd, where this ' +
            "release's tag is already on HEAD, so git answers with THAT tag and the notes range collapses to nothing — " +
            "a published Release with an empty body, and nothing else in the pipeline would go red",
    );
} else {
    // The behaviour the flag is relied on for, in a scratch repository: two release tags, HEAD on the newer.
    const scratch = mkdtempSync(join(tmpdir(), "release-range-"));
    try {
        const git = (...args) => spawnSync("git", args, { cwd: scratch, encoding: "utf8" });
        git("init", "-q", "-b", "main");
        git("-c", "user.email=c@example.com", "-c", "user.name=c", "commit", "-q", "--allow-empty", "-m", "one");
        git("tag", "v1.0.0");
        git("-c", "user.email=c@example.com", "-c", "user.name=c", "commit", "-q", "--allow-empty", "-m", "two");
        git("tag", "v1.1.0");
        const describe = (...extra) => git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", ...extra).stdout?.trim();
        if (describe() !== "v1.1.0") {
            rangeProblems.push(`git describe on a tagged HEAD answered ${describe() || "nothing"}, not the tag it stands on — this check can no longer show what the flag prevents`);
        }
        if (describe("--exclude", "v1.1.0") !== "v1.0.0") {
            rangeProblems.push(`\`--exclude\` no longer skips the tag on HEAD (answered ${describe("--exclude", "v1.1.0") || "nothing"}), so publish-github.sh's notes range is not what it thinks`);
        }
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
}

finish(
    [
        ["The release-body headings drifted apart (they are parsed, not prose)", headingDrift],
        ["The release notes are built from a range that would come back empty", rangeProblems],
    ],
    [
        `release headings: the writer and all ${HEADING_FILES.length - 1} parsers spell the same two sections, ` +
            `and the notes range still excludes the tag publishCmd is standing on`,
    ],
);
