#!/usr/bin/env node
// Release-body headings are one contract spelled in four files with no dependency edge: publish-github.sh writes them,
// three parsers read them back off the Release. A drifted spelling fails nothing at runtime; the section is just
// silently unseen.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finish } from "./lib/report.mjs";
import { root } from "./lib/repo.mjs";

const HEADINGS = ["What's new", "Breaking changes"];
const HEADING_FILES = [
    "_tools/scripts/release/publish-github.sh",
    "_sandbox/sandbox/src/platform/boot/release-notes.ts",
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

// Runs as semantic-release's publishCmd, so this release's tag is already on HEAD; without `--exclude "$TAG"`, `git
// describe` answers with it and the range collapses to nothing. Demonstrated in a throwaway repo: the flag had no test
// coverage.

// A git command lands wherever GIT_DIR and its siblings point, not `cwd`, and git exports them to child processes
// including this one. Strips inherited GIT_* vars and config, and verifies the scratch repo's own git dir before
// writing anything.
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
