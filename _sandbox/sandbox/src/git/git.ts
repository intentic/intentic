import { errorMessage } from "@intentic/base/errors";
import type { PushRefusal } from "@intentic/sandbox-contract";
import { GIT_GLOBAL_ARGS, type GitRunner, literalPathspecs } from "@intentic/scaffold";
import type { TerminalRunner } from "../terminal/terminal-run.js";
import { shellQuote } from "@intentic/sandbox-run/quote";

// A GitRunner that executes visibly through a terminal session (capability flows, the user watches the actual
// git commands). Output is the pane's combined stream (stderr merged); the parsed cases (status --porcelain,
// rev-parse) are stderr-free on success, and a non-zero exit throws like defaultGit's rejection. The generic git
// verbs (init/clone/status/commitAll/push/checkout/head/listFiles/sync) live in @intentic/scaffold.
export const terminalGit =
    (runner: TerminalRunner, session: string): GitRunner =>
    async (dir, args) => ({
        // Same pathspec marking the direct runner applies (scaffold's literalPathspecs): a visible git in a pane
        // must act on exactly the paths a hidden one would, or Discard means two different things per route.
        stdout: await runner.run(session, ["git", ...GIT_GLOBAL_ARGS, "-C", dir, ...literalPathspecs(args)].map(shellQuote).join(" "), {
            cwd: dir,
            window: "git",
        }),
        stderr: "",
    });

// The identity every daemon-authored commit carries (inventory edits, the neutral-ledger scaffold, the git
// routes). One source of truth so the workspace history reads consistently regardless of which route wrote it.
export const AGENT_GIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;

// git prefixes its verdicts and nothing else: `fatal:`, `error:`/`ERROR:`, `warning:`, and `remote:` for a line
// relayed from the server. Advice, `hint:` blocks, the `Please make sure you have the correct access rights /
// and the repository exists.` couplet, carries no prefix, which is exactly what makes it separable.
const VERDICT = /^(?:fatal|error|warning|remote):/i;

// A COMMIT-MSG HOOK'S REFUSAL, which git relays verbatim and prefixes with nothing of its own, so the rule
// above finds no verdict at all and the tail of the output is whatever the hook printed last. commitlint (this
// repo's hook, and the most common one in anybody else's) prints its findings as `✖   <what is wrong>
// [rule-name]`, then a `found N problems` count, then a "Get help:" link, so the panel showed the link, which
// is the one line that says nothing about the message the user has to fix. The trailing `[rule-name]` is what
// separates a finding from commitlint's own summary.
const COMMITLINT_FINDING = /^✖\s+(.+\[[a-z-]+\])$/;

// Why a git command failed, in one line for the panel. execFile rejects with the whole command line in
// `message`, so git's own stderr is strongly preferred when present.
//
// The LAST verdict line, not the last line: git ends a failed remote op with a wrapped advice paragraph, so
// taking the tail outright renders the panel a sentence fragment ("and the repository exists.") in place of the
// diagnosis. Last rather than first because the verdict follows whatever the server relayed above it, a push
// rejection's `error: failed to push some refs` after its `remote: error: …`, an auth failure's `fatal:
// Authentication failed` after the host's explanation. Falling back to the last non-empty line keeps the
// non-git rejections (a spawn failure, ENOENT) readable, since those carry no prefix at all.
export const gitFailureReason = (error: unknown, fallback: string): string => {
    const stderr = (error as { stderr?: unknown }).stderr;
    return gitVerdictLine(typeof stderr === "string" && stderr.trim() !== "" ? stderr : errorMessage(error), fallback);
};

// The same reading over text that did not arrive as an exception: the tail a terminal run hands back
// (git/push-run.ts), where stdout and stderr are one stream and there is no error object to look inside.
export const gitVerdictLine = (text: string, fallback: string): string => {
    const lines = text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    // EVERY finding, not the last one: a message routinely breaks two rules at once (a capitalised subject that
    // ends in a full stop), and a box that names one of them buys the user a second refusal.
    const findings = lines.map((line) => COMMITLINT_FINDING.exec(line)?.[1]).filter((finding) => finding !== undefined);
    if (findings.length > 0) {
        return findings.join("; ");
    }
    return lines.findLast((line) => VERDICT.test(line)) ?? lines.at(-1) ?? fallback;
};

/* WHO REFUSED A PUSH, read off git's own transcript, because the three answers ask three different things of
 * the owner (PushRefusalSchema) and only one of them is an agent's to fix.
 *
 * Measured against real git rather than remembered from its manual:
 *   · the REMOTE says no as a ref status line, ` ! [rejected] main -> main (fetch first)` or
 *     ` ! [remote rejected] … (protected branch hook declined)`, and git exits 1;
 *   · the TRANSPORT failing (a host that does not resolve, a path that is not a repository, a credential
 *     refused) is a `fatal:` that git exits 128 on, before any ref is even discussed;
 *   · the pre-push HOOK refusing prints whatever the hook printed and then git's one line,
 *     `error: failed to push some refs to '…'`, and exits 1: no ref status, no fatal.
 *
 * The LAST verdict line, not any line: a hook that runs a suite prints `fatal:` whenever a test does, and
 * reading the transcript for the word would file a refused gate under "check your credentials". What git
 * itself said last is the one line in the tail that is git's. */
const REJECTED_REF = /^\s*(!\s+\[(?:remote )?rejected\].*)$/m;
const FATAL_EXIT = 128;
export const pushRefusal = (output: string, exitCode: number | undefined): PushRefusal => {
    if (REJECTED_REF.test(output)) {
        return "remote";
    }
    if (exitCode === FATAL_EXIT || /^fatal:/i.test(gitVerdictLine(output, ""))) {
        return "transport";
    }
    return "hook";
};

// The one line of a refused push worth a row: for a ref the remote rejected it is the ref status line, which
// names the reason in brackets (`! [rejected] main -> main (fetch first)`) where git's verdict after it only
// says "failed to push some refs"; for everything else it is the verdict line the panel already reads.
export const pushRefusalReason = (output: string, fallback: string): string => {
    const rejected = REJECTED_REF.exec(output)?.[1];
    return rejected === undefined ? gitVerdictLine(output, fallback) : rejected.replaceAll(/\s+/g, " ").trim();
};
