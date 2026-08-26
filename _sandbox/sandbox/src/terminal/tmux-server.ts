import { execFile } from "node:child_process";
import { readlink } from "node:fs/promises";
import { promisify } from "node:util";
import type { Logger } from "pino";

const execFileAsync = promisify(execFile);

/* WHOSE MOUNTS EVERY TERMINAL IN THIS CONTAINER GETS, decided once, here, on purpose.
 *
 * A tmux client that finds no server running FORKS one, and that server keeps the mount namespace of whoever
 * forked it for life — for every pane it will ever create. Panes are where the owner's terminal tabs live, so
 * the namespace of one arbitrary client becomes the namespace of the owner's shells.
 *
 * That is not a theoretical ordering problem. An isolated turn runs in a namespace where `/work` IS that one
 * conversation's worktree (agents/isolation.ts), and the wrapper the agent's Bash goes through is a tmux
 * client. The first such command to arrive while no server happened to be running handed its private `/work`
 * to the server, and from then on the owner opened terminal tabs inside a stranger's worktree, on its branch,
 * with the main checkout nowhere on the filesystem and `git checkout main` refusing ("already checked out").
 * bin/tmux-run answers that for ITSELF by hopping to the daemon's namespace first (isolation.ts TMUX_NS_ENV).
 *
 * This is the answer for everyone else. The wrapper's hop is a rule every future tmux caller has to remember,
 * and the callers are not all ours: the repo's own integration tests speak to this socket, and so does
 * anything an agent runs, detaches, or writes. So the daemon forks the server ITSELF, at boot, before a turn
 * can exist — and the race is not won, it is gone. Nothing can fork a server that is already running.
 *
 * `exit-empty off` is what makes "already running" true for the container's whole life: tmux's default is to
 * exit the moment its last session is destroyed, and sessions are destroyed all the time (the reaper, the
 * panel's "clear finished terminals", the owner closing a tab). Every one of those would hand the next fork
 * to whoever asked first. With it off the server outlives every session it holds, so it is forked exactly
 * once, here, by us.
 *
 * The holder session exists only to make the fork happen — `tmux start-server` alone exits immediately on
 * 3.3a, having no session to keep it alive — and is killed as soon as the option is set. It is named and
 * detached so it can never be mistaken for a real terminal in the panel's list if the kill somehow fails.
 */
const HOLDER_SESSION = "intentic-server-pin";

// Best-effort throughout: a container without tmux, or one where the server is already up (a daemon restart
// inside a live container), must boot exactly as before. The only thing that would be worse than not pinning
// is failing to start because of it.
export const pinTmuxServer = async (logger: Logger): Promise<void> => {
    try {
        // `new-session -d` is the fork. `-A` so a server that IS already running (daemon restart) is attached
        // to rather than erroring, which keeps the option write below on the same code path either way.
        await execFileAsync("tmux", ["new-session", "-A", "-d", "-s", HOLDER_SESSION], { timeout: 10_000 });
        await execFileAsync("tmux", ["set-option", "-g", "exit-empty", "off"], { timeout: 10_000 });
        await execFileAsync("tmux", ["kill-session", "-t", `=${HOLDER_SESSION}`], { timeout: 10_000 }).catch(() => undefined);
        logger.info({ session: HOLDER_SESSION }, "tmux: server pinned to the daemon's namespace");
    } catch (err) {
        logger.warn({ err }, "tmux: could not pin the server; terminals fall back to fork-on-demand");
    }
};

/* The invariant the pin exists to hold, asked of the running server rather than assumed.
 *
 * Undefined means "no answer to give": no server, no tmux, or a kernel that does not expose the link. Only a
 * definite mismatch is a finding — the pin can be defeated by a server that predates this daemon (a container
 * whose daemon restarted after a turn had already forked one), and that server is exactly the condition that
 * used to run for hours with nothing to show for it but a confused owner.
 */
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

// Say it once per check, loudly enough to be found later: an owner whose terminals open in the wrong tree has
// no way to tell from inside one of them, and this is the only place that can see both sides.
export const reportTmuxServerNamespace = async (logger: Logger): Promise<void> => {
    const leak = await tmuxServerLeaked();
    if (leak !== undefined) {
        logger.error(
            { ...leak },
            "tmux: the running server is in a foreign mount namespace — terminals will open in an agent's worktree, not the workspace; restart the sandbox to reclaim it",
        );
    }
};
