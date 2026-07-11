import type { GitRunner } from "@intentic/scaffold";
import { shellQuote, type TerminalRunner } from "../system/terminal-run.js";

// A GitRunner that executes visibly through a terminal session (capability flows — the user watches the actual
// git commands). Output is the pane's combined stream (stderr merged); the parsed cases (status --porcelain,
// rev-parse) are stderr-free on success, and a non-zero exit throws like defaultGit's rejection. The generic git
// verbs (init/clone/status/commitAll/push/checkout/head/listFiles/sync) live in @intentic/scaffold.
export const terminalGit =
    (runner: TerminalRunner, session: string): GitRunner =>
    async (dir, args) => ({
        stdout: await runner.run(session, ["git", "-C", dir, ...args].map(shellQuote).join(" "), { cwd: dir, window: "git" }),
        stderr: "",
    });

// The identity every daemon-authored commit carries (inventory edits, the neutral-ledger scaffold, the git
// routes). One source of truth so the workspace history reads consistently regardless of which route wrote it.
export const AGENT_GIT_AUTHOR = { name: "intentic", email: "agent@intentic.dev" } as const;
