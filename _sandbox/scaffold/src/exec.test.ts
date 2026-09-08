import { expect, test } from "vitest";
import { GIT_GLOBAL_ARGS, literalPathspecs } from "./exec.js";

// Pins that literalPathspecs marks every arg after `--` literal, since git wildmatches raw paths (`report[1].txt`
// matches `report1.txt`); the real git behavior is pinned in changes.integration.test.ts.

test("every argument after the pathspec separator is marked literal", () => {
    expect(literalPathspecs(["checkout", "-q", "-f", "HEAD", "--", "report[1].txt", "b.txt"])).toEqual([
        "checkout",
        "-q",
        "-f",
        "HEAD",
        "--",
        ":(literal)report[1].txt",
        ":(literal)b.txt",
    ]);
});

// An option merely starting with `--` (not equal to it) is not the separator, e.g. `--cached`, `--ignore-unmatch`.
test("a long option is not the separator", () => {
    expect(literalPathspecs(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", "a.txt"])).toEqual([
        "rm",
        "-r",
        "-q",
        "--cached",
        "--ignore-unmatch",
        "--",
        ":(literal)a.txt",
    ]);
});

test("args with no separator, and a separator with nothing after it, are left exactly as they were", () => {
    const noSeparator = ["status", "--porcelain=v2", "-z", "-uall"];
    expect(literalPathspecs(noSeparator)).toEqual(noSeparator);
    const trailing = ["diff", "HEAD", "--"];
    expect(literalPathspecs(trailing)).toEqual(trailing);
});

// Scans from the end: the last `--` is git's separator, so a commit message that is itself `--` can't be mistaken for
// one.
test("a commit message that looks like the separator does not become one", () => {
    expect(literalPathspecs(["commit", "-q", "--only", "-m", "--", "--", "notes.md"])).toEqual([
        "commit",
        "-q",
        "--only",
        "-m",
        "--",
        "--",
        ":(literal)notes.md",
    ]);
});

// update-index takes literal filenames after `--`, not pathspecs; `:(literal)a.txt` would silently match nothing and
// exit 0, leaving the gitlink tracked.
test("plumbing that takes filenames rather than pathspecs is left alone", () => {
    const untrack = ["update-index", "--force-remove", "--", "nested/repo"];
    expect(literalPathspecs(untrack)).toEqual(untrack);
    // Includes `-c` global pairs ahead of the verb, since the verb is read past those first.
    const withGlobals = ["-c", "core.fileMode=false", "update-index", "--force-remove", "--", "nested/repo"];
    expect(literalPathspecs(withGlobals)).toEqual(withGlobals);
});

// --literal-pathspecs is global to the process; git's own commands build pathspecs internally, so it would break
// something like `git stash push --include-untracked`.
test("the global args carry no process-wide pathspec flag", () => {
    expect(GIT_GLOBAL_ARGS).not.toContain("--literal-pathspecs");
});
