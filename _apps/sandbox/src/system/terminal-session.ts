import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Shared naming rules for the web terminal's tmux sessions, used by both the WebSocket route (which spawns
// `tmux new-session -s <name>`) and the control-plane list/kill routes (which run `tmux kill-session -t <name>`).
// The name reaches a shell-out argv, so the charset is the security guard: alnum/underscore/dash only, and the
// first char can't be `-` (else tmux reads a name like `-C` as a flag even in an execFile argv). The `web-`
// prefix marks sessions this UI owns, so `list` shows only those (not sessions the agent/user opened by hand).

const execFileAsync = promisify(execFile);

export const WEB_SESSION_PREFIX = "web-";

// Sessions the Claude agent's Bash commands run in (bin/tmux-run, wired by src/agent/agent-terminals.ts):
// one per SDK session, listed with the web/panel sessions so the owner can watch the agent work live.
export const AGENT_SESSION_PREFIX = "agent-";

// Sessions the daemon's terminal runner (src/system/terminal-run.ts) executes user-triggered flows in —
// capability adds, infra check — window per command, listed like the others so the owner watches the real
// shell actions instead of invisible child processes.
export const JOB_SESSION_PREFIX = "job-";

// One job session per capability id (ids are manifest-unique and their charset — /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
// max 60 — is a subset of the session-name guard below, so no sanitizing).
export const capabilityJobSession = (id: string): string => `${JOB_SESSION_PREFIX}capability-${id}`;

// The infra Check flow's session: `intentic resolve` and `intentic plan` run here as windows.
export const INFRA_CHECK_SESSION = `${JOB_SESSION_PREFIX}infra-check`;

const SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export const isValidSessionName = (name: string): boolean => SESSION_NAME.test(name);

// How long a DETACHED web-* shell may sit inactive before the hourly sweep reaps it. web-* sessions are the
// user's own, so the boot sweep leaves them alone — but an abandoned one (browser gone for days) would
// otherwise live until the container restarts. 48h of `session_activity` silence with no client attached is
// abandonment; an unattached-but-busy long build keeps refreshing its activity stamp, and an attached shell is
// never reaped. The terminal route's ws-level liveness terminates vanished browsers, so `session_attached` 0
// is trustworthy.
const REAP_IDLE_MS = 48 * 3_600_000;

export const reapIdleWebSessions = async (): Promise<void> => {
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync("tmux", ["list-sessions", "-F", "#{session_name} #{session_attached} #{session_activity}"]));
    } catch {
        // no tmux server ⇒ nothing to reap
        return;
    }
    const cutoff = Date.now() - REAP_IDLE_MS;
    await Promise.all(
        stdout.split("\n").map(async (line) => {
            const [name, attached, activity] = line.split(" ");
            if (name === undefined || !name.startsWith(WEB_SESSION_PREFIX) || attached !== "0") {
                return;
            }
            const activityMs = Number(activity) * 1000;
            if (!Number.isFinite(activityMs) || activityMs > cutoff) {
                return;
            }
            await execFileAsync("tmux", ["kill-session", "-t", `=${name}`]).catch(() => undefined);
        }),
    );
};
