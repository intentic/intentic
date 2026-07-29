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

// The infra Check flow's session: `intentic deploy resolve` and `intentic deploy plan` run here as windows.
export const INFRA_CHECK_SESSION = `${JOB_SESSION_PREFIX}infra-check`;

const SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export const isValidSessionName = (name: string): boolean => SESSION_NAME.test(name);

// RETENTION — the hourly sweep that keeps the tmux server from silting up.
//
// Two clocks, because the two kinds of session mean different things. A web-* shell is a PLACE the user works
// in: it only ages out when it has plainly been abandoned. An agent-* or job-* session is a RECORD of work that
// has already finished — the panel stops tabbing it the moment it finishes (the browser's rule; see the web
// app's useTerminal), so past this window it is a session nobody can see and nothing will ever write to again.
//
// Reaping one costs NOTHING, which is what lets this run unattended and the UI ask no confirmation: every
// pane's bytes are already on disk under historyRoot/logs/terminals (logs/log-files.ts, its own 30-day prune),
// and an agent's commands are in its transcript besides. The tab was never the record.
//
// The guards are about not yanking something out from under someone, not about disk:
//   · attached — a browser is looking at this session RIGHT NOW
//   · live — any pane still running (a long unattended build keeps refreshing its activity stamp too)
//   · keep — an agent between two commands, or a job whose runner still has work queued: every pane is dead
//     but the flow is not finished (system.routes draws the same line for `running`). A PREDICATE rather than
//     a list because that is the shape both sources come in: the fleet registry enumerates its live agents,
//     the terminal runner only answers per session.
// The terminal route's ws-level liveness terminates vanished browsers, so `session_attached` 0 is trustworthy.
const REAP_IDLE_MS = 48 * 3_600_000;
const REAP_FINISHED_MS = 2 * 3_600_000;

// One `list-panes -a` line per pane, carrying its SESSION's attach state and activity stamp alongside the
// pane's own liveness — one call answers "is anyone watching, is anything running, how long ago was that".
const SWEEP_FORMAT = "#{session_name} #{session_attached} #{session_activity} #{pane_dead}";

// The pure decision, so the policy is testable without a tmux server. An unparseable activity stamp reads as
// "just now" (the session is skipped): the flag gates a kill, so the safe direction is "keep".
export const reapableSessions = (stdout: string, now: number, keep: (session: string) => boolean): string[] => {
    const states = new Map<string, { attached: boolean; live: boolean; activityAt: number }>();
    for (const line of stdout.split("\n")) {
        const [name, attached, activity, dead] = line.split(" ");
        if (name === undefined || name === "" || dead === undefined) {
            continue;
        }
        const activitySeconds = Number(activity);
        states.set(name, {
            attached: attached !== "0",
            live: dead !== "1" || states.get(name)?.live === true,
            activityAt: Number.isFinite(activitySeconds) && activitySeconds > 0 ? activitySeconds * 1000 : now,
        });
    }
    return [...states]
        .filter(([name, { attached, live, activityAt }]) => {
            if (attached || keep(name)) {
                return false;
            }
            if (name.startsWith(WEB_SESSION_PREFIX)) {
                return activityAt <= now - REAP_IDLE_MS;
            }
            if (name.startsWith(AGENT_SESSION_PREFIX) || name.startsWith(JOB_SESSION_PREFIX)) {
                return !live && activityAt <= now - REAP_FINISHED_MS;
            }
            // panel-* sessions are managed dev servers — started and stopped explicitly, never aged out.
            return false;
        })
        .map(([name]) => name);
};

export const reapFinishedSessions = async (keep: (session: string) => boolean): Promise<void> => {
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", SWEEP_FORMAT]));
    } catch {
        // no tmux server ⇒ nothing to reap
        return;
    }
    await Promise.all(
        reapableSessions(stdout, Date.now(), keep).map((name) => execFileAsync("tmux", ["kill-session", "-t", `=${name}`]).catch(() => undefined)),
    );
};
