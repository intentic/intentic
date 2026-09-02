import { expect, test } from "vitest";
import { gitFailureReason, pushRefusal, pushRefusalReason } from "./git.js";

// Verbatim stderr from real git failures: the shapes the panel actually has to render.
test("gitFailureReason keeps git's verdict rather than the advice paragraph trailing it", () => {
    // The one that shipped a sentence fragment to the panel: git's advice couplet wraps across two lines, so
    // the LAST line is "and the repository exists.": a clause, with the diagnosis two lines above it.
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

// A commit-msg hook's output, relayed by git with no verdict of its own: the shape that reached the panel as
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
    // A spawn failure carries no stderr and no git prefix: the message's last line is all there is.
    expect(gitFailureReason(new Error("Command failed: git fetch --prune\nspawn git ENOENT"), "git failed")).toBe("spawn git ENOENT");
    expect(gitFailureReason(new Error(""), "git failed")).toBe("git failed");
});

/* WHO REFUSED A PUSH, over transcripts git actually printed (captured by push-run.integration.test.ts's real
 * runs, and pasted here so the reading is pinned without a clone per case). The one that matters is the
 * hook's: a suite that prints `fatal:` on the way to its own verdict must not be filed under "check your
 * credentials", which is why the reading is of git's LAST word and the exit code, not of any line. */
test("pushRefusal files a ref the remote rejected under remote, whatever else was printed", () => {
    const diverged =
        "To /tmp/origin.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/tmp/origin.git'\nhint: Updates were rejected because the remote contains work that you do\nhint: not have locally.\n";
    expect(pushRefusal(diverged, 1)).toBe("remote");
    const protectedBranch =
        "remote: error: GH006: Protected branch update failed for refs/heads/main.\nTo github.com:acme/app.git\n ! [remote rejected] main -> main (protected branch hook declined)\nerror: failed to push some refs to 'github.com:acme/app.git'\n";
    expect(pushRefusal(protectedBranch, 1)).toBe("remote");
});

test("pushRefusal files a push that never reached the remote under transport", () => {
    const notARepo =
        "fatal: '/tmp/does-not-exist.git' does not appear to be a git repository\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    expect(pushRefusal(notARepo, 128)).toBe("transport");
    const noHost =
        "ssh: Could not resolve hostname nonexistent.invalid: Name or service not known\nfatal: Could not read from remote repository.\n\nPlease make sure you have the correct access rights\nand the repository exists.\n";
    expect(pushRefusal(noHost, 128)).toBe("transport");
    expect(pushRefusal("fatal: could not read Username for 'https://github.com': terminal prompts disabled\n", 128)).toBe("transport");
});

test("pushRefusal files the pre-push hook's no under hook, even when the hook's own output says fatal", () => {
    const gate = "verify-push: typecheck failed; the push does not go\nerror: failed to push some refs to '/tmp/origin.git'\n";
    expect(pushRefusal(gate, 1)).toBe("hook");
    const suite = "fatal: a test printed this word\nverify-push: tests failed; the push does not go\nerror: failed to push some refs to '/tmp/origin.git'\n";
    expect(pushRefusal(suite, 1)).toBe("hook");
});

test("pushRefusalReason names the ref the remote rejected and why, and otherwise git's verdict", () => {
    const diverged = "To /tmp/origin.git\n ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/tmp/origin.git'\n";
    expect(pushRefusalReason(diverged, "git refused the push")).toBe("! [rejected] main -> main (fetch first)");
    const gate = "verify-push: typecheck failed; the push does not go\nerror: failed to push some refs to '/tmp/origin.git'\n";
    expect(pushRefusalReason(gate, "git refused the push")).toBe("error: failed to push some refs to '/tmp/origin.git'");
    expect(pushRefusalReason("", "git refused the push")).toBe("git refused the push");
});
