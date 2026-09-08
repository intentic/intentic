import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { JOB_SESSION_PREFIX, WEB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";

// Tmux session-name charset for the WebSocket route and control-plane list/kill routes: alnum, underscore, dash only,
// first char not `-` (tmux reads it as a flag). Prefixes are contract vocabulary from session-names.ts.

const execFileAsync = promisify(execFile);

// Ids are manifest-unique and already match the session-name charset, so no sanitizing here.
export const capabilityJobSession = (id: string): string => `${JOB_SESSION_PREFIX}capability-${id}`;

// Infra Check flow session: `intentic deploy resolve` and `intentic deploy plan` run here as windows.
export const INFRA_CHECK_SESSION = `${JOB_SESSION_PREFIX}infra-check`;

// One session for all check windows (pre-push, turn-required); named to match the push dialog's wording.
export const CHECKS_SESSION = `${JOB_SESSION_PREFIX}checks`;

// Human label for a job session id (e.g. `job-checks` -> `Checks`), used in the tab and work popover.
export const jobSessionLabel = (session: string): string => {
    const words = session.slice(JOB_SESSION_PREFIX.length).replace(/-/g, " ");
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export const isValidSessionName = (name: string): boolean => SESSION_NAME.test(name);

// 100k lines can be tens of MB; execFile's 1MB default would silently truncate mid-line.
const CAPTURE_MAX_BYTES = 64 * 1_048_576;

// No `-e`: colour escapes would ride into a copied selection. `truncated` is inferred from count >= requested;
// undefined means tmux could not capture (no server or session gone).
export const captureScrollback = async (session: string, lines: number): Promise<{ text: string; lines: number; truncated: boolean } | undefined> => {
    let stdout: string;
    try {
        // `=<name>:` exact-matches the session; a bare name would prefix-match `name-suffix` once `name` is gone.
        ({ stdout } = await execFileAsync("tmux", ["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", `=${session}:`], {
            maxBuffer: CAPTURE_MAX_BYTES,
        }));
    } catch {
        return undefined;
    }
    // capture-pane pads to the pane's height; trailing blank rows are stripped so they aren't copied as output.
    const text = stdout.trimEnd();
    const captured = text === "" ? 0 : text.split("\n").length;
    return { text, lines: captured, truncated: captured >= lines };
};

// web-* shells age out only when abandoned; job-* sessions age out sooner since the browser drops them once finished.
// agent-* sessions belong to the conversation reaper (platform/reaper.ts), not this sweep.
const REAP_IDLE_MS = 48 * 3_600_000;
const REAP_FINISHED_MS = 2 * 3_600_000;

// One list-panes line per pane: session attach state, activity stamp, and the pane's own liveness.
const SWEEP_FORMAT = "#{session_name} #{session_attached} #{session_activity} #{pane_dead}";

// Pure so the reap policy is testable without a tmux server; an unparseable activity stamp reads as now, so the session
// is kept.
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
            // agent-* sessions are reaped by platform/reaper.ts; panel-* sessions stop explicitly, neither ages out
            // here.
            return false;
        })
        .map(([name]) => name);
};

// Maps each pane's root pid to its session; everything in a pane descends from that pid (ports/port-scan.ts walks it
// up). Skips an unparseable pid rather than guessing wrong session.
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

// Every live pane's root pid to its session name; empty when there is no tmux server.
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
