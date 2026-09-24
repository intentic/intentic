import { JOB_SESSION_PREFIX, WEB_SESSION_PREFIX } from "@intentic/sandbox-contract/session-names";
import { forkedExec } from "@intentic/scaffold";
import { isNoTmuxServer } from "./tmux-server.js";

// Tmux session-name charset for the WebSocket route and control-plane list/kill routes: alnum, underscore, dash only,
// first char not `-` (tmux reads it as a flag). Prefixes are contract vocabulary from session-names.ts.

// A panel's session (processes/managed-processes.ts). Wire data: session names reach the browser and are string-built
// there; never rename this prefix.
export const PANEL_SESSION_PREFIX = "panel-";

// A supervised service's (processes/service-processes.ts): its own prefix so its terminal tails the service's log
// (terminal-plan.ts) instead of attaching a tmux session; none exists for it.
export const SERVICE_SESSION_PREFIX = "svc-";

// Ids are manifest-unique and already match the session-name charset, so no sanitizing here.
export const capabilityJobSession = (id: string): string => `${JOB_SESSION_PREFIX}capability-${id}`;

// Infra Check flow session: `intentic deploy resolve` and `intentic deploy plan` run here as windows.
export const INFRA_CHECK_SESSION = `${JOB_SESSION_PREFIX}infra-check`;

// Every conversation's turn checks, one after another; nothing the owner starts by hand may run here and queue behind them.
export const CHECKS_SESSION = `${JOB_SESSION_PREFIX}checks`;

// The owner's pushes: only another push can queue ahead of one, and only a push can take over its pane afterwards.
export const PUSH_SESSION = `${JOB_SESSION_PREFIX}push`;

// Human label for a job session id (e.g. `job-checks` -> `Checks`), used in the tab and work popover.
export const jobSessionLabel = (session: string): string => {
    const words = session.slice(JOB_SESSION_PREFIX.length).replace(/-/g, " ");
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

const SESSION_NAME = /^[A-Za-z0-9_][A-Za-z0-9_-]*$/;

export const isValidSessionName = (name: string): boolean => SESSION_NAME.test(name);

// 100k lines can be tens of MB, past the default cap on a command's output.
const CAPTURE_MAX_BYTES = 64 * 1_048_576;

// No `-e`: colour escapes would ride into a copied selection. `truncated` is inferred from count >= requested;
// undefined means tmux could not capture (no server or session gone).
export const captureScrollback = async (session: string, lines: number): Promise<{ text: string; lines: number; truncated: boolean } | undefined> => {
    let stdout: string;
    try {
        // `=<name>:` exact-matches the session; a bare name would prefix-match `name-suffix` once `name` is gone.
        ({ stdout } = await forkedExec("tmux", ["capture-pane", "-p", "-J", "-S", `-${lines}`, "-t", `=${session}:`], {
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

// web-* shells age out only when abandoned; job-* sessions and finished one-shot runs age out sooner since the browser
// drops them once finished. agent-* sessions belong to the conversation reaper (platform/reaper.ts), not this sweep.
const REAP_IDLE_MS = 48 * 3_600_000;
const REAP_FINISHED_MS = 2 * 3_600_000;

// One list-panes line per pane: session attach state, activity stamp, and the pane's own liveness.
const SWEEP_FORMAT = "#{session_name} #{session_attached} #{session_activity} #{pane_dead}";

export interface ReapPolicy {
    // Spares work the panes can't see, e.g. a job whose runner still has commands queued for it.
    readonly keep: (session: string) => boolean;
    // When a one-shot run completed, undefined for anything else. Its shell survives its command, so the pane's own
    // liveness would keep a finished install or check alive for the life of the sandbox.
    readonly finishedRunAt: (session: string) => number | undefined;
}

// Pure so the reap policy is testable without a tmux server; an unparseable activity stamp reads as now, so the session
// is kept.
export const reapableSessions = (stdout: string, now: number, policy: ReapPolicy): string[] => {
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
            if (attached || policy.keep(name)) {
                return false;
            }
            if (name.startsWith(WEB_SESSION_PREFIX)) {
                return activityAt <= now - REAP_IDLE_MS;
            }
            if (name.startsWith(JOB_SESSION_PREFIX)) {
                return !live && activityAt <= now - REAP_FINISHED_MS;
            }
            // A run that ended: its shell is alive at a prompt, so `live` says nothing and the manager's own stamp is
            // the clock.
            const finishedAt = policy.finishedRunAt(name);
            if (finishedAt !== undefined) {
                return finishedAt <= now - REAP_FINISHED_MS;
            }
            // agent-* sessions are reaped by platform/reaper.ts; a dev-server panel stops explicitly, neither ages out
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

// Every live pane's root pid to its session name; empty when there is no tmux server, and a failed listing throws, since
// the reaper spares exactly the processes under these pids.
export const panePids = async (): Promise<Map<number, string>> => {
    const listed = await forkedExec("tmux", ["list-panes", "-a", "-F", "#{session_name} #{pane_pid}"]).catch((error: unknown) => {
        if (isNoTmuxServer(error)) {
            return undefined;
        }
        throw error;
    });
    return listed === undefined ? new Map() : panePidSessions(listed.stdout);
};

export const reapFinishedSessions = async (policy: ReapPolicy): Promise<void> => {
    let stdout: string;
    try {
        ({ stdout } = await forkedExec("tmux", ["list-panes", "-a", "-F", SWEEP_FORMAT]));
    } catch {
        // no tmux server ⇒ nothing to reap
        return;
    }
    await Promise.all(
        reapableSessions(stdout, Date.now(), policy).map((name) => forkedExec("tmux", ["kill-session", "-t", `=${name}`]).catch(() => undefined)),
    );
};
