import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { AGENT_SESSION_PREFIX, JOB_SESSION_PREFIX, WEB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";

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

// The pre-push check's session — named for the word the push dialog uses ("Checks failed", "Stop checks"), so
// the tab the user is sent to and the dialog that sent them there say the same thing.
export const PREPUSH_SESSION = `${JOB_SESSION_PREFIX}checks`;

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
// in: it only ages out when it has plainly been abandoned. An agent-* or job-* session is the shell work HAPPENED
// in, and the browser lists none of them once they finish — no tab, no popover row (see the web app's
// useTerminal and useWorkTerminals). This window is the grace period on that: long enough that the surfaces
// naming ONE directly — the chat's Bash card on the turn that just ended, the Capabilities page on the install
// that just landed — still open something, then gone.
//
// Reaping one costs NOTHING, which is what lets this run unattended: every pane's bytes are already on disk
// under historyRoot/logs/terminals (logs/log-files.ts, its own 30-day prune), and an agent's commands are in its
// transcript besides. The tab was never the record.
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
