import { readlink } from "node:fs/promises";
import { errnoCode } from "@intentic/base/errors";
import type { Logger } from "pino";
import { forkedExec } from "@intentic/base/git";
import { CONTAINER_SECRET_ENV } from "../env.config.js";
import { DAEMON_GEN_ENV, DAEMON_ONLY_ENV, WORKLOAD_ENV } from "../seams/workload-stamp.js";

// What tmux printed on its way out, when a failed exec carried it.
const stderrOf = (error: unknown): string | undefined => {
    const stderr = typeof error === "object" && error !== null ? (error as { stderr?: unknown }).stderr : undefined;
    return typeof stderr === "string" ? stderr : undefined;
};

// tmux's answer for "no sessions exist": no binary, no socket, nothing listening on it, or a server holding no session.
// The last is the daemon's own normal state between boot and the first terminal (pinTmuxServer keeps an emptied server
// alive), and tmux 3.5a answers every lookup there, `list-panes -a` and an exact `-t =name` alike, with "no current
// target". Any other failure left the question unanswered and must not read as "nothing is running".
export const isNoTmuxServer = (error: unknown): boolean => {
    if (errnoCode(error) === "ENOENT") {
        return true;
    }
    return /no server running on |error connecting to .* \(No such file or directory\)|^no current target$/m.test(stderrOf(error) ?? "");
};

// tmux's answer for a lookup by name that found nothing: no server at all (above), or a running server without that
// session or window, which 3.5a reports as "can't find window: <name>" even for a `-t =session` lookup.
export const isNoTmuxTarget = (error: unknown): boolean => isNoTmuxServer(error) || /^can't find (session|window)/m.test(stderrOf(error) ?? "");

// A tmux client that finds no server forks one, keeping the forker's mount namespace for every pane it holds; an
// isolated turn forking it first would put every terminal in that turn's worktree. The daemon forks it at boot via a
// holder session (killed right after); `exit-empty off` keeps the server alive so nothing else can win the fork.
export const HOLDER_SESSION = "intentic-server-pin";

// What the server's own environment must not hand every pane it starts (2026-10-05): netd's two sockets, which a
// server netd or an earlier daemon started holds, a daemon run's generation, which would date every pane by the run
// that happened to start the server, and every container secret (2026-10-06): a server netd forked for the owner's
// terminal before the daemon sealed its own environment holds the whole container env. The tmux sessions have their
// own sweeps.
const SCRUBBED_SERVER_ENV = [...DAEMON_ONLY_ENV, DAEMON_GEN_ENV, ...CONTAINER_SECRET_ENV];

/** Whether tmux already copies the owner stamp from a creating client into each new session it makes. */
export const copiesOwnerStamp = (updateEnvironment: string): boolean =>
    updateEnvironment
        .split("\n")
        .map((line) => line.trim())
        .includes(WORKLOAD_ENV);

// Takes the daemon-only variables out of the server's global environment, and has a session made by a client whose
// environment names a conversation (an agent's shell running `tmux new-session`) carry that owner, so the reaper can
// tell the sessions an agent made by hand from a person's (system/boot/reaper.ts). Idempotent, best-effort.
export const prepareTmuxServer = async (logger: Logger): Promise<void> => {
    for (const name of SCRUBBED_SERVER_ENV) {
        await forkedExec("tmux", ["set-environment", "-g", "-u", name], { timeout: 10_000 }).catch(() => undefined);
    }
    try {
        const { stdout } = await forkedExec("tmux", ["show-options", "-gv", "update-environment"], { timeout: 10_000 });
        if (!copiesOwnerStamp(stdout)) {
            await forkedExec("tmux", ["set-option", "-ga", "update-environment", WORKLOAD_ENV], { timeout: 10_000 });
        }
    } catch (err) {
        // No server yet: the daemon's own pin starts it from an environment that no longer holds them.
        if (!isNoTmuxServer(err)) {
            logger.warn({ err }, "tmux: sessions an agent makes by hand will not carry its conversation");
        }
    }
};

// Best-effort: a container without tmux, or one where the server is already up (a daemon restart), must boot exactly as
// before; not pinning is better than failing to start.
export const pinTmuxServer = async (logger: Logger): Promise<void> => {
    try {
        // `-d` forks; `-A` attaches rather than erroring if a server already exists (daemon restart).
        await forkedExec("tmux", ["new-session", "-A", "-d", "-s", HOLDER_SESSION], { timeout: 10_000 });
        await forkedExec("tmux", ["set-option", "-g", "exit-empty", "off"], { timeout: 10_000 });
        await prepareTmuxServer(logger);
        await forkedExec("tmux", ["kill-session", "-t", `=${HOLDER_SESSION}`], { timeout: 10_000 }).catch(() => undefined);
        logger.info({ session: HOLDER_SESSION }, "tmux: server pinned to the daemon's namespace");
    } catch (err) {
        logger.warn({ err }, "tmux: could not pin the server; terminals fall back to fork-on-demand");
    }
};

// Undefined means no answer to give (no server, no tmux, no namespace link); only a definite mismatch, a server
// predating this daemon, is a finding.
export const tmuxServerLeaked = async (): Promise<{ server: string; daemon: string } | undefined> => {
    try {
        const { stdout } = await forkedExec("tmux", ["display", "-p", "#{pid}"], { timeout: 10_000 });
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
