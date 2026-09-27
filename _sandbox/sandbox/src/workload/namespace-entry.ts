import { shellQuote } from "@intentic/sandbox-run/quote";

// Entering a turn's mount namespace (conversations/worktrees/isolation.ts builds it, and its anchor process keeps it
// alive): the argv and the shell prefix every entrant uses, so no caller spells nsenter's flags twice.

// `--wd` resolves before setns, landing on the daemon's unreachable /work (this crashed the Codex app-server at
// startup). `--wdns` resolves after setns, the only reading of /work that means the worktree.
// `--wdns` moves the kernel's cwd, but the entrant inherits the daemon's own stale `$PWD`, and bash's check passes
// since both names are one inode. Unset, not reassigned, so every shell falls back to the correct getcwd().
const NO_INHERITED_CWD = ["env", "-u", "PWD", "-u", "OLDPWD"] as const;

// The program to spawn and its argv: nsenter, carrying the entrant's own command and arguments after `--`.
export interface NamespaceEntrant {
    readonly command: string;
    readonly args: string[];
}

export const nsenterArgv = (anchorPid: number, cwd: string, command: string, args: readonly string[]): NamespaceEntrant => ({
    command: "nsenter",
    args: [`--mount=/proc/${anchorPid}/ns/mnt`, `--wdns=${cwd}`, "--", ...NO_INHERITED_CWD, command, ...args],
});

// The same flags as one shell word, for callers that compose a command string rather than an argv (the tmux rewrite, a
// rule's command), where an inherited PWD would decide a relative path's meaning. Quoted against a space splitting it.
export const nsenterPrefix = (anchorPid: number, cwd: string): string =>
    `nsenter --mount=/proc/${anchorPid}/ns/mnt --wdns=${shellQuote(cwd)} -- ${NO_INHERITED_CWD.join(" ")} `;
