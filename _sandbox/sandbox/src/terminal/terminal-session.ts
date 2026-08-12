import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JOB_SESSION_PREFIX, WEB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";

// Shared naming rules for the web terminal's tmux sessions, used by both the WebSocket route (which spawns
// `tmux new-session -s <name>`) and the control-plane list/kill routes (which run `tmux kill-session -t <name>`).
// The name reaches a shell-out argv, so the charset is the security guard: alnum/underscore/dash only, and the
// first char can't be `-` (else tmux reads a name like `-C` as a flag even in an execFile argv). The prefixes
// themselves are contract vocabulary (session-names.ts) — the web app and extensions read the same names off
// GET /system/terminals — so only the shell-out rules live here.

const execFileAsync = promisify(execFile);

// One job session per capability id (ids are manifest-unique and their charset — /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/,
// max 60 — is a subset of the session-name guard below, so no sanitizing).
export const capabilityJobSession = (id: string): string => `${JOB_SESSION_PREFIX}capability-${id}`;

// The infra Check flow's session: `intentic deploy resolve` and `intentic deploy plan` run here as windows.
export const INFRA_CHECK_SESSION = `${JOB_SESSION_PREFIX}infra-check`;

// Where a rule's command runs, whichever moment it stands at — the pre-push check and the command a turn has
// to pass before it can finish are both windows in here. Named for the word the push dialog uses ("Checks
// failed", "Stop checks"), so the tab the user is sent to and the thing that sent them there agree; one
// session rather than one per moment, because what the user wants is a place to read their checks.
export const CHECKS_SESSION = `${JOB_SESSION_PREFIX}checks`;

const SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export const isValidSessionName = (name: string): boolean => SESSION_NAME.test(name);

// A capture of 100k lines is a few tens of MB of text; execFile's 1MB default would truncate it into a
// mid-line stub and report success.
const CAPTURE_MAX_BYTES = 64 * 1_048_576;

// One session's pane history as plain text — what the browser has no other route to, because its live view is
// a tmux client on the ALTERNATE screen and the scrollback the wheel moves through never leaves this side of
// the socket. `-p` prints to stdout, `-S -<n>` starts n lines back (tmux clamps to the history it has), `-J`
// rejoins lines a program hard-wrapped so a copied URL or path comes back whole. Deliberately no `-e`: this is
// read and copied, and colour escapes would ride along into the selection.
//
// `truncated` distinguishes the two ways a capture can end — at the request's own limit, or at the beginning of
// the history. tmux reports neither, so it is inferred from the count coming back at or above what was asked
// for. Undefined when tmux cannot capture at all (no server, or the session is gone), which the route answers
// as a NOT_FOUND rather than as an empty scrollback — an empty history and a missing session read the same
// otherwise, and only one of them is worth telling the user about.
export const captureScrollback = async (session: string, lines: number): Promise<{ text: string; lines: number; truncated: boolean } | undefined> => {
    let stdout: string;
    try {
        // `=<name>:` — the trailing colon is what makes tmux read this as a SESSION (its current window's
        // active pane) rather than as a pane name, which is the only spelling `=` exact-matching survives here:
        // a bare `=web-a` is looked up as a pane and simply fails, and a bare `web-a` would prefix-match
        // `web-ab` once `web-a` is gone.
        ({ stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", `=${session}:`], {
            maxBuffer: CAPTURE_MAX_BYTES,
        }));
    } catch {
        return undefined;
    }
    // capture-pane pads the visible screen out to the pane's height, so a short session ends in blank rows that
    // are nothing but the terminal's own empty space — they'd be selected and copied along with the real output.
    const text = stdout.trimEnd();
    const captured = text === "" ? 0 : text.split("\n").length;
    return { text, lines: captured, truncated: captured >= lines };
};

// RETENTION — the hourly sweep that keeps the tmux server from silting up.
//
// Two clocks, because the two kinds of session mean different things. A web-* shell is a PLACE the user works
// in: it only ages out when it has plainly been abandoned. A job-* session is the shell work HAPPENED in, and
// the browser lists none of them once they finish — no tab, no popover row (see the web app's useTerminal and
// useWorkTerminals). This window is the grace period on that: long enough that the surface naming ONE directly
// — the Capabilities page on the install that just landed — still opens something, then gone.
//
// agent-* sessions are NOT this sweep's any more: they belong to a conversation, and the reaper retires them on
// the conversation's own stop clock — live panes included (platform/reaper.ts). This sweep would need a second
// definition of "finished" to touch them, and a session with one still-running dev server pane would have sat
// here forever, exactly as it used to.
//
// Reaping one costs NOTHING, which is what lets this run unattended: every pane's bytes are already on disk
// under historyRoot/logs/terminals (logs/log-files.ts, its own 30-day prune). The tab was never the record.
//
// The guards are about not yanking something out from under someone, not about disk:
//   · attached — a browser is looking at this session RIGHT NOW
//   · live — any pane still running (a long unattended build keeps refreshing its activity stamp too)
//   · keep — a job whose runner still has work queued: every pane is dead but the flow is not finished
//     (system.routes draws the same line for `running`).
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
            if (name.startsWith(JOB_SESSION_PREFIX)) {
                return !live && activityAt <= now - REAP_FINISHED_MS;
            }
            // agent-* sessions are the reaper's (owner-clocked, platform/reaper.ts); panel-* sessions are
            // managed dev servers — started and stopped explicitly. Neither ages out here.
            return false;
        })
        .map(([name]) => name);
};

/* WHICH SESSION A PROCESS IS RUNNING IN, from the one end tmux will tell us about: each pane's root process.
 * Everything a pane runs descends from that pid, so a listener's owner is found by walking its ancestry until a
 * pane pid matches (see ports/port-scan.ts) — which is the only way a port bound by `pnpm dev`'s great-grandchild
 * can be traced back to the terminal a user could Ctrl+C it in.
 *
 * The pure parse is separate so the walk is testable without a tmux server. A pane whose pid doesn't parse is
 * skipped rather than defaulting: a wrong session name sends the user to someone else's terminal. */
export const panePidSessions = (stdout: string): Map<number, string> => {
    const panes = new Map<number, string>();
    for (const line of stdout.split("\n")) {
        const [name, pid] = line.split(" ");
        const paneProcess = Number(pid);
        if (name === undefined || name === "" || !Number.isInteger(paneProcess) || paneProcess <= 0) {
            continue;
        }
        panes.set(paneProcess, name);
    }
    return panes;
};

// Every live pane's root pid → its session name. Empty when there is no tmux server, which is the same answer
// as "nothing here runs in a terminal" and needs no distinction.
export const panePids = async (): Promise<Map<number, string>> => {
    try {
        const { stdout } = await execFileAsync("tmux", ["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"]);
        return panePidSessions(stdout);
    } catch {
        return new Map();
    }
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
