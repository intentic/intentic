import { GIT_GLOBAL_ARGS, type GitRunner } from "@intentic/scaffold";
import { shellQuote, type TerminalRunner } from "../terminal/terminal-run.js";

// A GitRunner that executes visibly through a terminal session (capability flows — the user watches the actual
// git commands). Output is the pane's combined stream (stderr merged); the parsed cases (status --porcelain,
// rev-parse) are stderr-free on success, and a non-zero exit throws like defaultGit's rejection. The generic git
// verbs (init/clone/status/commitAll/push/checkout/head/listFiles/sync) live in @intentic/scaffold.
export const terminalGit =
    (runner: TerminalRunner, session: string): GitRunner =>
    async (dir, args) => ({
        stdout: await runner.run(session, ["git", ...GIT_GLOBAL_ARGS, "-C", dir, ...args].map(shellQuote).join(" "), { cwd: dir, window: "git" }),
        stderr: "",
    });

// The identity every daemon-authored commit carries (inventory edits, the neutral-ledger scaffold, the git
// routes). One source of truth so the workspace history reads consistently regardless of which route wrote it.
export const AGENT_GIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;

// git prefixes its verdicts and nothing else: `fatal:`, `error:`/`ERROR:`, `warning:`, and `remote:` for a line
// relayed from the server. Advice — `hint:` blocks, the `Please make sure you have the correct access rights /
// and the repository exists.` couplet — carries no prefix, which is exactly what makes it separable.
const VERDICT = /^(?:fatal|error|warning|remote):/i;

// Why a git command failed, in one line for the panel. execFile rejects with the whole command line in
// `message`, so git's own stderr is strongly preferred when present.
//
// The LAST verdict line, not the last line: git ends a failed remote op with a wrapped advice paragraph, so
// taking the tail outright renders the panel a sentence fragment ("and the repository exists.") in place of the
// diagnosis. Last rather than first because the verdict follows whatever the server relayed above it — a push
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
    return lines.findLast((line) => VERDICT.test(line)) ?? lines.at(-1) ?? fallback;
};
