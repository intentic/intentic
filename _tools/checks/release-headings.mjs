#!/usr/bin/env node
/* THE RELEASE-BODY HEADINGS ARE ONE CONTRACT SPELLED IN FOUR FILES that share no dependency edge:
 * publish-github.sh writes "## Breaking changes" and "## What's new" into the Release, and the daemon's update
 * card (release-notes.ts), the site's changelog page (changelog.ts) and the community announcement
 * (post-release-discord.mjs) parse them back off it. Each parser is deliberately its own copy: the files say
 * why, so nothing but this check notices a drifted spelling. And a drift fails NOTHING at runtime: the section
 * simply stops being seen, which for the breaking heading means a breaking update is offered as routine, the
 * one silence the heading exists to prevent. */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
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

/* THE THROWAWAY REPOSITORY THOSE ASSERTIONS ARE ASKED IN: two release tags, HEAD on the newer, handed to
 * `demonstrate` as a `describe` bound to it. It exists only inside the call, because afterwards it is deleted.
 *
 * A DIRECTORY IS NOT WHERE A GIT COMMAND LANDS: THE ENVIRONMENT IS. GIT_DIR and git's other per-invocation
 * variables outrank `cwd` entirely, and git EXPORTS them to its own children — a pre-push hook is one, and so
 * is everything that hook runs, this check included. Inherited here they make this no scratch repository at
 * all: `init` re-initialises whatever GIT_DIR names, the commits land on THAT repository's branch, `tag
 * v1.0.0` collides with the release tag it already carries, and `describe` answers with its newest tag instead
 * of the v1.1.0 built two lines up. Both assertions then fire and name publish-github.sh, which is untouched.
 * Not a hazard someone imagined: it is what refused a push with `git describe … answered v1.238.0` while the
 * release script was perfect, and what wrote the commits into the pusher's own checkout on the way.
 *
 * So: an environment with nothing of git's left in it (GIT_EXEC_PATH excepted — it says where git's own
 * subcommands live, not which repository a command acts on) and a config that is one absent file, so no
 * inherited `commit.gpgsign` or `init.templateDir` decides what the commits do either. Then the isolation is
 * PROVEN before anything is written: `init` names a git dir, and unless that git dir is the one in this temp
 * directory, the check says so and touches nothing. A check that builds a repository must be certain which
 * repository it is building.
 *
 * And a setup command that fails is reported AS THAT rather than as a drifted flag: "the scratch repo could
 * not be built" and "`--exclude` stopped working" are opposite diagnoses, and only one of them is about this
 * repository. */
const inScratchRepo = (demonstrate) => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "release-range-")));
    try {
        const absentConfig = join(scratch, "no-such-config");
        const env = {
            ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_") || name === "GIT_EXEC_PATH")),
            GIT_CONFIG_GLOBAL: absentConfig,
            GIT_CONFIG_SYSTEM: absentConfig,
        };
        const git = (...args) => spawnSync("git", args, { cwd: scratch, encoding: "utf8", env });
        const refused = (args, result) =>
            `the scratch repository this demonstrates \`--exclude\` in could not be built: \`git ${args.join(" ")}\` exited ` +
            `${result.status ?? "on a signal"}${(result.stderr ?? "").trim() === "" ? "" : ` (${(result.stderr ?? "").trim().split("\n")[0]})`}`;
        const init = ["init", "-q", "-b", "main"];
        const initResult = git(...init);
        if (initResult.status !== 0) {
            return [refused(init, initResult)];
        }
        const gitDir = git("rev-parse", "--absolute-git-dir").stdout?.trim();
        if (gitDir !== join(scratch, ".git")) {
            return [
                `the scratch repository's commands land in ${gitDir || "no repository at all"} rather than ${join(scratch, ".git")}: something in the ` +
                    "environment is redirecting git (GIT_DIR and its siblings outrank `cwd`), so this can demonstrate nothing from here and writes nothing",
            ];
        }
        const author = ["-c", "user.email=c@example.com", "-c", "user.name=c"];
        const history = [
            [...author, "commit", "-q", "--allow-empty", "-m", "one"],
            ["tag", "v1.0.0"],
            [...author, "commit", "-q", "--allow-empty", "-m", "two"],
            ["tag", "v1.1.0"],
        ];
        const failed = history.map((args) => [args, git(...args)]).find(([, result]) => result.status !== 0);
        return failed === undefined ? demonstrate((...extra) => git("describe", "--tags", "--abbrev=0", "--match", "v[0-9]*", ...extra).stdout?.trim()) : [refused(...failed)];
    } finally {
        rmSync(scratch, { recursive: true, force: true });
    }
};

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
    rangeProblems.push(
        ...inScratchRepo((describe) => [
            ...(describe() === "v1.1.0"
                ? []
                : [`git describe on a tagged HEAD answered ${describe() || "nothing"}, not the tag it stands on — this check can no longer show what the flag prevents`]),
            ...(describe("--exclude", "v1.1.0") === "v1.0.0"
                ? []
                : [
                      `\`--exclude\` no longer skips the tag on HEAD (answered ${describe("--exclude", "v1.1.0") || "nothing"}), ` +
                          "so publish-github.sh's notes range is not what it thinks",
                  ]),
        ]),
    );
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
