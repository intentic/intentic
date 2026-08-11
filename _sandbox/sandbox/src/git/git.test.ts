import { expect, test } from "vitest";
import { gitFailureReason } from "./git.js";

// Verbatim stderr from real git failures — the shapes the panel actually has to render.
test("gitFailureReason keeps git's verdict rather than the advice paragraph trailing it", () => {
    // The one that shipped a sentence fragment to the panel: git's advice couplet wraps across two lines, so
    // the LAST line is "and the repository exists." — a clause, with the diagnosis two lines above it.
    const unreachable = {
        stderr: "ERROR: Repository not found.\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n",
    };
    expect(gitFailureReason(unreachable, "git failed")).toBe("fatal: Could not read from remote repository.");
});

test("gitFailureReason prefers the verdict over a server line relayed above it", () => {
    const rejected = {
        stderr: "remote: error: GH006: Protected branch update failed for refs/heads/main.\nTo github.com:acme/app.git\n ! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs to 'github.com:acme/app.git'\n",
    };
    expect(gitFailureReason(rejected, "git failed")).toBe("error: failed to push some refs to 'github.com:acme/app.git'");
});

test("gitFailureReason keeps a hint block out of the panel", () => {
    const diverged = {
        stderr: "fatal: Not possible to fast-forward, aborting.\nhint: Updates were rejected because the tip of your current branch is behind\nhint: its remote counterpart.\n",
    };
    expect(gitFailureReason(diverged, "git failed")).toBe("fatal: Not possible to fast-forward, aborting.");
});

// A commit-msg hook's output, relayed by git with no verdict of its own — the shape that reached the panel as
// commitlint's help link and nothing else.
test("gitFailureReason names the rules a commit message broke rather than the help link under them", () => {
    const rejected = {
        stderr: "⧗   --- input ---\nFix: Something.\n✖   subject may not end with full stop [subject-full-stop]\n✖   type must be lower-case [type-case]\n\n✖   found 2 problems, 0 warnings\nⓘ   Get help: https://github.com/conventional-changelog/commitlint/#what-is-commitlint\n",
    };
    expect(gitFailureReason(rejected, "git failed")).toBe(
        "subject may not end with full stop [subject-full-stop]; type must be lower-case [type-case]",
    );
});

test("gitFailureReason reads a single-line failure and an execFile rejection with no stderr", () => {
    expect(gitFailureReason({ stderr: "fatal: could not read Username for 'https://github.com': terminal prompts disabled\n" }, "git failed")).toBe(
        "fatal: could not read Username for 'https://github.com': terminal prompts disabled",
    );
    // A spawn failure carries no stderr and no git prefix — the message's last line is all there is.
    expect(gitFailureReason(new Error("Command failed: git fetch --prune\nspawn git ENOENT"), "git failed")).toBe("spawn git ENOENT");
    expect(gitFailureReason(new Error(""), "git failed")).toBe("git failed");
});
