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
    const text = typeof stderr === "string" && stderr.trim() !== "" ? stderr : error instanceof Error ? error.message : String(error);
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
