import { shellQuote } from "@intentic/sandbox-run/quote";

// Entering a turn's namespaces (conversations/worktrees/isolation.ts builds them, and its anchor process keeps them
// alive): the argv and the shell prefix every entrant uses, so no caller spells nsenter's flags twice.

// `--wd` resolves before setns, landing on the daemon's unreachable /work (this crashed the Codex app-server at
// startup). `--wdns` resolves after setns, the only reading of /work that means the worktree.
// `--wdns` moves the kernel's cwd, but the entrant inherits the daemon's own stale `$PWD`, and bash's check passes
// since both names are one inode. Unset, not reassigned, so every shell falls back to the correct getcwd().
const NO_INHERITED_CWD = ["env", "-u", "PWD", "-u", "OLDPWD"] as const;

// A fenced turn's anchor is a sandbox (conversations/worktrees/turn-sandbox.ts), not a bare mount namespace: its own
// user, pid, uts and ipc namespaces besides the mount one, and an unprivileged user inside. An entrant joins all of
// them and takes that user before it runs anything, so it holds nothing the sandbox's own processes do not.
// Registered by pid, because every caller already hands this module the anchor's pid and nothing else: the runtime
// CLIs, tmux panes, hook and rule commands, diagnostics and the Codex and Cursor hosts all go through the two
// functions below, and none of them can then forget the difference.
export interface SandboxEntry {
    readonly uid: number;
    readonly gid: number;
}

const sandboxes = new Map<number, SandboxEntry>();

export const registerSandboxEntry = (anchorPid: number, entry: SandboxEntry): void => {
    sandboxes.set(anchorPid, entry);
};

export const forgetSandboxEntry = (anchorPid: number): void => {
    sandboxes.delete(anchorPid);
};

// The joining half for a sandbox: every namespace the anchor holds, then its user. `--setuid` to a non-zero id clears
// the capabilities the join itself grants, and `setpriv --no-new-privs` keeps any later exec from gaining one back.
const sandboxJoin = (anchorPid: number, entry: SandboxEntry): string[] => [
    `--target=${String(anchorPid)}`,
    "--user",
    "--mount",
    "--pid",
    "--uts",
    "--ipc",
    `--setuid=${String(entry.uid)}`,
    `--setgid=${String(entry.gid)}`,
];

const NO_NEW_PRIVS = ["setpriv", "--no-new-privs"] as const;

// The program to spawn and its argv: nsenter, carrying the entrant's own command and arguments after `--`.
export interface NamespaceEntrant {
    readonly command: string;
    readonly args: string[];
}

export const nsenterArgv = (anchorPid: number, cwd: string, command: string, args: readonly string[]): NamespaceEntrant => {
    const sandbox = sandboxes.get(anchorPid);
    if (sandbox !== undefined) {
        return {
            command: "nsenter",
            args: [...sandboxJoin(anchorPid, sandbox), `--wdns=${cwd}`, "--", ...NO_NEW_PRIVS, ...NO_INHERITED_CWD, command, ...args],
        };
    }
    return {
        command: "nsenter",
        args: [`--mount=/proc/${String(anchorPid)}/ns/mnt`, `--wdns=${cwd}`, "--", ...NO_INHERITED_CWD, command, ...args],
    };
};

// The same flags as one shell word, for callers that compose a command string rather than an argv (the tmux rewrite, a
// rule's command), where an inherited PWD would decide a relative path's meaning. Quoted against a space splitting it.
export const nsenterPrefix = (anchorPid: number, cwd: string): string => {
    const sandbox = sandboxes.get(anchorPid);
    if (sandbox !== undefined) {
        return `nsenter ${sandboxJoin(anchorPid, sandbox).join(" ")} --wdns=${shellQuote(cwd)} -- ${NO_NEW_PRIVS.join(" ")} ${NO_INHERITED_CWD.join(" ")} `;
    }
    return `nsenter --mount=/proc/${String(anchorPid)}/ns/mnt --wdns=${shellQuote(cwd)} -- ${NO_INHERITED_CWD.join(" ")} `;
};
