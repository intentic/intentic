import { expect, test } from "vitest";
import { GIT_GLOBAL_ARGS, literalPathspecs } from "./exec.js";

/* THE PATHS THIS DAEMON HANDS GIT ARE FILENAMES, NOT PATTERNS. Everything after a bare `--` is a row a user
 * ticked in the Changes panel or a path an agent named, and git wildmatches that position: `report[1].txt`
 * matches `report1.txt`, so one selected row acted on its neighbour. The behaviour itself is pinned against a
 * real repo in the sandbox's changes.integration.test.ts; what this file pins is the marking that gets it
 * there, including the cases where the marking must NOT happen. */

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

// `--cached`, `--force-remove`, `--ignore-unmatch`: an option that merely STARTS with two dashes is not the
// separator, and the daemon passes several of them ahead of real paths.
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

/* THE LAST `--` IS THE SEPARATOR, which is git's own rule and the reason this scans from the end. A commit
 * message is free text the user wrote, and a message of exactly `--` would otherwise be read as the separator:
 * the real one, and the path behind it, would then be marked as pathspecs of a commit that never got its file. */
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

/* THE PLUMBING EXCEPTION, and it is the one that fails SILENTLY when it is missed. `update-index` takes literal
 * filenames after `--`, not pathspecs: `git update-index --force-remove -- ':(literal)a.txt'` exits 0 and
 * removes nothing at all, so the root-repo untrack pass would report success and leave the gitlink in the
 * index. Verified against git 2.39 before this set was written. */
test("plumbing that takes filenames rather than pathspecs is left alone", () => {
    const untrack = ["update-index", "--force-remove", "--", "nested/repo"];
    expect(literalPathspecs(untrack)).toEqual(untrack);
    // Including behind the `-c` pairs every call carries, which is what the verb is read past.
    const withGlobals = ["-c", "core.fileMode=false", "update-index", "--force-remove", "--", "nested/repo"];
    expect(literalPathspecs(withGlobals)).toEqual(withGlobals);
});

/* THE FLAG THIS IS NOT. `--literal-pathspecs` would do the same job in one word, and it is the wrong tool: it
 * is global to the git process, and git's own commands build pathspecs with magic internally. With it set,
 * `git stash push --include-untracked` reports success and leaves the untracked files in the tree — measured,
 * and it is what sent this back to the drawing board. */
test("the global args carry no process-wide pathspec flag", () => {
    expect(GIT_GLOBAL_ARGS).not.toContain("--literal-pathspecs");
});
