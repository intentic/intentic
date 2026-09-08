import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { Logger } from "pino";

const execFileAsync = promisify(execFile);

// A tmux client that finds no server forks one, keeping the forker's mount namespace for every pane it holds; an
// isolated turn forking it first would put every terminal in that turn's worktree. The daemon forks it at boot via a
// holder session (killed right after); `exit-empty off` keeps the server alive so nothing else can win the fork.
const HOLDER_SESSION = "intentic-server-pin";

// Best-effort: a container without tmux, or one where the server is already up (a daemon restart), must boot exactly as
// before; not pinning is better than failing to start.
export const pinTmuxServer = async (logger: Logger): Promise<void> => {
    try {
        // `-d` forks; `-A` attaches rather than erroring if a server already exists (daemon restart).
        await execFileAsync("tmux", ["new-session", "-A", "-d", "-s", HOLDER_SESSION], { timeout: 10_000 });
        await execFileAsync("tmux", ["set-option", "-g", "exit-empty", "off"], { timeout: 10_000 });
        await execFileAsync("tmux", ["kill-session", "-t", `=${HOLDER_SESSION}`], { timeout: 10_000 }).catch(() => undefined);
        logger.info({ session: HOLDER_SESSION }, "tmux: server pinned to the daemon's namespace");
    } catch (err) {
        logger.warn({ err }, "tmux: could not pin the server; terminals fall back to fork-on-demand");
    }
};

// Undefined means no answer to give (no server, no tmux, no namespace link); only a definite mismatch, a server
// predating this daemon, is a finding.
export const tmuxServerLeaked = async (): Promise<{ server: string; daemon: string } | undefined> => {
    try {
        const { stdout } = await execFileAsync("tmux", ["display", "-p", "#{pid}"], { timeout: 10_000 });
        const pid = Number(stdout.trim());
        if (!Number.isInteger(pid) || pid <= 0) {
            return undefined;
        }
        const [server, daemon] = await Promise.all([readlink(`/proc/${String(pid)}/ns/mnt`), readlink(`/proc/${String(process.pid)}/ns/mnt`)]);
        return server === daemon ? undefined : { server, daemon };
    } catch {
        return undefined;
    }
};

// Logged once per check: an owner whose terminals open in the wrong tree can't tell from inside one, and this is the
// only place that sees both sides.
export const reportTmuxServerNamespace = async (logger: Logger): Promise<void> => {
    const leak = await tmuxServerLeaked();
    if (leak !== undefined) {
        logger.error(
            { ...leak },
            "tmux: the running server is in a foreign mount namespace — terminals will open in an agent's worktree, not the workspace; restart the sandbox to reclaim it",
        );
    }
};
